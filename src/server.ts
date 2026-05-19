import "dotenv/config";
import { serve } from "@hono/node-server";
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { PDFParse } from "pdf-parse";
import { messageStore, type StoredMessage, type StoredUser } from "./store.js";

type ChatProvider = "openai" | "google" | "claude";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "apikey"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

const SYSTEM_PROMPT = `You are a helpful AI assistant for problem-solving support. Provide clear, structured responses using markdown formatting with professional mathematical equation rendering.

IMPORTANT: You have access to DALL-E 3 for image generation. When a student asks you to generate, create, or draw an image, diagram, or illustration, tell them to use the "Generate Image" button located next to the "Attach Files" button.

Formatting requirements:
- Format ordinary explanations, definitions, comparisons, writing feedback, and study help as polished learning notes, not as a single plain paragraph.
- Prefer rich educational structure: a short title, concise overview, clear section headings, worked steps, key idea callouts, and a short final takeaway when useful.
- Use headings, bullets, numbered lists, tables, and horizontal rules when they improve clarity. Put one main idea per paragraph.
- For conceptual questions, explain the intuition first, then define terms and steps in order. Use examples, analogies, and "key idea" callouts when they help learning.
- For multi-step concepts, break the answer into named sections with concise bullets under each section.
- For mathematical or technical problems, show assumptions, formulas, substitutions, and final answer clearly.
- For code, use fenced code blocks with a language tag such as \`\`\`python.
- Use inline LaTeX with $...$ and display equations with $$...$$.
- Keep mathematical delimiters correct. If punctuation or brackets are part of the math, keep them inside the delimiters.
- This is a professional educational environment, so mathematical notation should be clear and publication-quality.
- Avoid dumping dense plain paragraphs when a structured answer would be easier to learn from.
- When the user asks for a general explanation, make the answer visually scannable with headings and short grouped bullets similar to a well-formatted study guide.

Attachment handling:
- If PDFs, images, audio, or documents are included in the request, they have been attached for you through the model API. Read and use the attached content directly.
- Do not say you cannot view, open, access, or interpret attached files when file parts are present in the request.
- If an attached file is unreadable, corrupted, blank, too large, or contains scanned text that cannot be extracted, say exactly that limitation and explain what you could read.
- When answering about a PDF or image, base the answer on the attached file content, not only on the filename or the user's description.`;

const tokenSecret = process.env.AUTH_TOKEN_SECRET || "local-development-change-me";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const passwordHash = pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return { salt, passwordHash };
}

function verifyPassword(password: string, user: StoredUser) {
  const { passwordHash } = hashPassword(password, user.salt);
  return timingSafeEqual(Buffer.from(passwordHash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function signToken(user: Pick<StoredUser, "id" | "email" | "name">) {
  const payload = base64UrlEncode(JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  }));
  const signature = base64UrlEncode(createHmac("sha256", tokenSecret).update(payload).digest());
  return `${payload}.${signature}`;
}

function verifyToken(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = base64UrlEncode(createHmac("sha256", tokenSecret).update(payload).digest());
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

  const parsed = JSON.parse(base64UrlDecode(payload)) as { sub: string; email: string; name: string; exp: number };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

function authResponse(user: Pick<StoredUser, "id" | "email" | "name">) {
  return {
    access_token: signToken(user),
    user: {
      id: user.id,
      email: user.email,
      user_metadata: {
        name: user.name,
      },
    },
  };
}

function normalizeProvider(value: unknown): ChatProvider {
  const normalized = String(value || "openai").toLowerCase();
  if (normalized === "google" || normalized === "gemini") return "google";
  if (normalized === "claude" || normalized === "anthropic") return "claude";
  return "openai";
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.type === "image_url") return "[Image attached]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function getDataUrlPayload(content: string) {
  const markerIndex = content.indexOf(",");
  return markerIndex >= 0 ? content.slice(markerIndex + 1) : content;
}

function getAudioInputFormat(file: any): "wav" | "mp3" | null {
  const fileType = String(file?.type || "").toLowerCase();
  const fileName = String(file?.name || "").toLowerCase();

  if (fileType === "audio/wav" || fileType === "audio/x-wav" || fileName.endsWith(".wav")) return "wav";
  if (fileType === "audio/mpeg" || fileType === "audio/mp3" || fileName.endsWith(".mp3")) return "mp3";
  return null;
}

function getAudioMimeType(file: any): string | null {
  const fileType = String(file?.type || "").toLowerCase();
  const fileName = String(file?.name || "").toLowerCase();

  if (fileType.startsWith("audio/")) return fileType;
  if (fileName.endsWith(".wav")) return "audio/wav";
  if (fileName.endsWith(".mp3")) return "audio/mpeg";
  return null;
}

function isPdfFile(file: any): boolean {
  const fileType = String(file?.type || "").toLowerCase();
  const fileName = String(file?.name || "").toLowerCase();
  return fileType === "application/pdf" || fileName.endsWith(".pdf");
}

function getImageMimeType(file: any): string | null {
  const fileType = String(file?.type || "").toLowerCase();
  const fileName = String(file?.name || "").toLowerCase();

  if (["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif"].includes(fileType)) return fileType;
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".gif")) return "image/gif";
  if (fileName.endsWith(".webp")) return "image/webp";
  if (fileName.endsWith(".heic")) return "image/heic";
  if (fileName.endsWith(".heif")) return "image/heif";
  return null;
}

function hasOpenAIAudioInput(files: any[] = []) {
  return files.some((file) => Boolean(getAudioInputFormat(file)));
}

function hasAudioInput(files: any[] = []) {
  return files.some((file) => Boolean(getAudioMimeType(file)));
}

function hasPdfInput(files: any[] = []) {
  return files.some(isPdfFile);
}

async function extractPdfText(file: any): Promise<string> {
  const base64Data = getDataUrlPayload(file.content || "");
  if (!base64Data) return "";

  const parser = new PDFParse({ data: Buffer.from(base64Data, "base64") });
  try {
    const data = await parser.getText();
    return String(data.text || "").trim();
  } finally {
    await parser.destroy();
  }
}

function getOpenAIResponseText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim() || "No response generated.";
}

async function uploadOpenAIInputFile(openaiApiKey: string, file: any): Promise<string> {
  const base64Data = getDataUrlPayload(file.content || "");
  const bytes = Buffer.from(base64Data, "base64");
  const formData = new FormData();

  formData.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    file.name || "document.pdf",
  );
  formData.append("purpose", "user_data");

  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`OpenAI file upload error: ${errorData.error?.message || "Unknown error"}`);
  }

  const data = await response.json();
  if (!data?.id) {
    throw new Error("OpenAI file upload did not return a file id");
  }
  return data.id;
}

async function deleteOpenAIInputFile(openaiApiKey: string, fileId: string) {
  try {
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
      },
    });
  } catch (error) {
    console.warn(`Failed to delete temporary OpenAI file ${fileId}:`, error);
  }
}

async function uploadGoogleInputFile(googleApiKey: string, file: any, mimeType: string) {
  const base64Data = getDataUrlPayload(file.content || "");
  const bytes = Buffer.from(base64Data, "base64");
  const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${googleApiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({
      file: {
        display_name: file.name || "attached-file",
      },
    }),
  });

  if (!startResponse.ok) {
    const errorData = await startResponse.json().catch(() => ({}));
    throw new Error(`Google AI file upload start error: ${errorData.error?.message || "Unknown error"}`);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Google AI file upload did not return an upload URL");
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: new Uint8Array(bytes),
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(`Google AI file upload error: ${errorData.error?.message || "Unknown error"}`);
  }

  const data = await uploadResponse.json();
  if (!data?.file?.uri) {
    throw new Error("Google AI file upload did not return a file URI");
  }

  return data.file as { name?: string; uri: string; mimeType?: string };
}

async function waitForGoogleInputFile(googleApiKey: string, file: { name?: string; uri: string; mimeType?: string }) {
  if (!file.name) return file;

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${googleApiKey}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Google AI file readiness error: ${errorData.error?.message || "Unknown error"}`);
    }

    const data = await response.json();
    const readyFile = data?.file || data;
    const state = String(readyFile?.state || "ACTIVE").toUpperCase();

    if (state === "ACTIVE") {
      return {
        name: readyFile.name || file.name,
        uri: readyFile.uri || file.uri,
        mimeType: readyFile.mimeType || file.mimeType,
      };
    }

    if (state === "FAILED") {
      throw new Error(`Google AI could not process attached file ${file.name}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 750 + attempt * 250));
  }

  throw new Error(`Google AI file ${file.name} was still processing after waiting`);
}

async function deleteGoogleInputFile(googleApiKey: string, fileName?: string) {
  if (!fileName) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${googleApiKey}`, {
      method: "DELETE",
    });
  } catch (error) {
    console.warn(`Failed to delete temporary Google AI file ${fileName}:`, error);
  }
}

function buildConversationText(message: string, conversationHistory: any[] = [], files: any[] = []) {
  const historyText = conversationHistory
    .map((msg: any) => `${msg.role === "assistant" ? "Assistant" : "User"}: ${flattenMessageContent(msg.content)}`)
    .filter((line) => line.trim())
    .join("\n\n");

  const fileText = files.length > 0
    ? `\n\nAttached files are included in this request and should be read directly:\n${files.map((file: any, index: number) => {
        if (file.type?.startsWith("image/")) return `${index + 1}. Image: ${file.name}`;
        if (file.type?.startsWith("audio/")) return `${index + 1}. Audio: ${file.name}`;
        if (isPdfFile(file)) return `${index + 1}. PDF: ${file.name}`;
        if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return `${index + 1}. Word document: ${file.name}`;
        return `${index + 1}. ${file.name}\n${file.content || ""}`;
      }).join("\n")}`
    : "";

  return [historyText, `User: ${message}${fileText}`].filter(Boolean).join("\n\n");
}

function buildOpenAIMessages(message: string, conversationHistory: any[] = [], files: any[] = []) {
  const includesAudioInput = hasOpenAIAudioInput(files);
  const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }];

  conversationHistory.forEach((msg: any) => {
    messages.push({ role: msg.role, content: msg.content });
  });

  if (files.length > 0) {
    const contentParts: any[] = [{ type: "text", text: message }];

    for (const file of files) {
      const audioFormat = getAudioInputFormat(file);

      if (audioFormat) {
        contentParts.push({
          type: "input_audio",
          input_audio: {
            data: getDataUrlPayload(file.content || ""),
            format: audioFormat,
          },
        });
      } else if (file.type?.startsWith("image/") && !includesAudioInput) {
        contentParts.push({
          type: "image_url",
          image_url: { url: file.content },
        });
      } else if (file.type?.startsWith("image/")) {
        contentParts[0].text += `\n\n[Image attached but not sent as image because this request includes audio: ${file.name}]`;
      } else {
        contentParts[0].text += `\n\n[Attached file: ${file.name}]`;
      }
    }

    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: message });
  }

  return messages;
}

async function runOpenAIChat(message: string, conversationHistory: any[] = [], files: any[] = []) {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error("OpenAI API key not configured");
  }

  if (hasPdfInput(files)) {
    const uploadedFileIds: string[] = [];
    const contentParts: any[] = [
      {
        type: "input_text",
        text: `${buildConversationText(message, conversationHistory, files)}\n\nThe attached PDF files have been uploaded as OpenAI input files. Read the PDF contents directly before answering.`,
      },
    ];

    try {
      for (const file of files) {
        if (isPdfFile(file)) {
          const fileId = await uploadOpenAIInputFile(openaiApiKey, file);
          uploadedFileIds.push(fileId);
          contentParts.push({
            type: "input_file",
            file_id: fileId,
          });
        } else if (file.type?.startsWith("image/")) {
          contentParts.push({
            type: "input_image",
            image_url: file.content,
          });
        }
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          instructions: SYSTEM_PROMPT,
          input: [{ role: "user", content: contentParts }],
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`OpenAI API error: ${errorData.error?.message || "Unknown error"}`);
      }

      return getOpenAIResponseText(await response.json());
    } finally {
      await Promise.all(uploadedFileIds.map((fileId) => deleteOpenAIInputFile(openaiApiKey, fileId)));
    }
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: hasOpenAIAudioInput(files) ? "gpt-audio" : "gpt-4o",
      messages: buildOpenAIMessages(message, conversationHistory, files),
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`OpenAI API error: ${errorData.error?.message || "Unknown error"}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "No response generated.";
}

async function runGoogleChat(message: string, conversationHistory: any[] = [], files: any[] = []) {
  const googleApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!googleApiKey) {
    throw new Error("Google AI API key not configured");
  }

  const uploadedFiles: Array<{ name?: string; uri: string; mimeType?: string }> = [];
  const extractedPdfSections: string[] = [];
  const parts: any[] = [];

  try {
    for (const file of files) {
      const audioMimeType = getAudioMimeType(file);

      if (audioMimeType) {
        parts.push({
          inline_data: {
            mime_type: audioMimeType,
            data: getDataUrlPayload(file.content || ""),
          },
        });
      } else if (isPdfFile(file)) {
        let extractedText = "";
        try {
          extractedText = await extractPdfText(file);
        } catch (error) {
          console.warn(`Failed to extract PDF text from ${file.name || "attached PDF"}:`, error);
        }

        if (extractedText) {
          extractedPdfSections.push(`PDF: ${file.name || "attached PDF"}\n${extractedText}`);
        }

        const uploadedFile = await uploadGoogleInputFile(googleApiKey, file, "application/pdf");
        const readyFile = await waitForGoogleInputFile(googleApiKey, uploadedFile);
        uploadedFiles.push(readyFile);
        parts.push({
          text: `Attached PDF file: ${file.name || "document.pdf"}. Read this PDF directly, including page images/diagrams if text extraction is incomplete.`,
        });
        parts.push({
          file_data: {
            mime_type: readyFile.mimeType || "application/pdf",
            file_uri: readyFile.uri,
          },
        });
      } else {
        const imageMimeType = getImageMimeType(file);
        if (imageMimeType) {
          parts.push({
            text: `Attached image file: ${file.name || "image"}. Inspect this image directly before answering, including any visible text, labels, diagrams, equations, tables, or screenshots.`,
          });
          parts.push({
            inline_data: {
              mime_type: imageMimeType,
              data: getDataUrlPayload(file.content || ""),
            },
          });
        }
      }
    }

    const extractedPdfText = extractedPdfSections.length > 0
      ? `\n\nExtracted PDF text for Google AI. Use this as the actual PDF content:\n\n${extractedPdfSections.join("\n\n---\n\n")}`
      : "";
    const fileReferenceInstruction = uploadedFiles.length > 0
      ? "\n\nPDF attachments are provided as Gemini file references. Read those files directly before answering; use extracted text only as a helper when available. Image attachments are provided inline; inspect their visual content directly."
      : "";
    const promptText = `${SYSTEM_PROMPT}\n\n${buildConversationText(message, conversationHistory, files)}${extractedPdfText}${fileReferenceInstruction}`;
    parts.push({ text: promptText });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.7 },
        }),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Google AI API error: ${errorData.error?.message || "Unknown error"}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("\n") || "No response generated.";
  } finally {
    await Promise.all(uploadedFiles.map((file) => deleteGoogleInputFile(googleApiKey, file.name)));
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

function isOpenAIAvailabilityError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("quota")
    || message.includes("billing")
    || message.includes("insufficient_quota")
    || message.includes("rate limit")
    || message.includes("429");
}

async function runProviderChat(provider: ChatProvider, message: string, conversationHistory: any[] = [], files: any[] = []) {
  if (provider === "google") return runGoogleChat(message, conversationHistory, files);
  if (provider === "claude") return runClaudeChat(message, conversationHistory, files);
  return runOpenAIChat(message, conversationHistory, files);
}

async function runChatWithFallback(selectedProvider: ChatProvider, message: string, conversationHistory: any[] = [], files: any[] = []) {
  try {
    return {
      response: await runProviderChat(selectedProvider, message, conversationHistory, files),
      providerUsed: selectedProvider,
    };
  } catch (error) {
    if (selectedProvider !== "openai" || !isOpenAIAvailabilityError(error)) {
      throw error;
    }

    console.warn("OpenAI is unavailable; trying fallback providers:", getErrorMessage(error));
    const fallbackErrors: string[] = [];

    for (const fallbackProvider of ["google", "claude"] as ChatProvider[]) {
      try {
        const fallbackResponse = await runProviderChat(fallbackProvider, message, conversationHistory, files);
        const providerName = fallbackProvider === "google" ? "Google AI" : "Claude";
        return {
          response: "OpenAI is currently unavailable because its API quota or billing limit was reached, so this response was generated with " + providerName + " instead.\n\n" + fallbackResponse,
          providerUsed: fallbackProvider,
          fallbackReason: getErrorMessage(error),
        };
      } catch (fallbackError) {
        const fallbackMessage = getErrorMessage(fallbackError);
        fallbackErrors.push(`${fallbackProvider}: ${fallbackMessage}`);
        console.warn(`Fallback provider ${fallbackProvider} failed:`, fallbackMessage);
      }
    }

    throw new Error(`OpenAI is unavailable and fallback providers also failed. ${fallbackErrors.join(" | ")}`);
  }
}

async function runClaudeChat(message: string, conversationHistory: any[] = [], files: any[] = []) {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("Claude API key not configured");
  }

  if (hasAudioInput(files)) {
    throw new Error("Claude raw audio input is not supported by this backend. Please use OpenAI or Google AI for audio recordings.");
  }

  const userContent: any[] = [];

  for (const file of files) {
    const imageMimeType = getImageMimeType(file);

    if (isPdfFile(file)) {
      userContent.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: getDataUrlPayload(file.content || ""),
        },
      });
    } else if (imageMimeType) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: imageMimeType,
          data: getDataUrlPayload(file.content || ""),
        },
      });
    }
  }

  userContent.push({
    type: "text",
    text: `${message}${files.length ? `\n\nAttached files:\n${files.map((file: any) => file.name).join("\n")}` : ""}`,
  });

  const messages = [
    ...conversationHistory.map((msg: any) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: flattenMessageContent(msg.content),
    })),
    { role: "user", content: userContent },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Claude API error: ${errorData.error?.message || errorData.error?.type || "Unknown error"}`);
  }

  const data = await response.json();
  return data.content?.map((part: any) => part.text || "").join("\n") || "No response generated.";
}

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/signup", async (c) => {
  try {
    const { email, password, name } = await c.req.json<{ email?: string; password?: string; name?: string }>();
    const normalizedEmail = normalizeEmail(email || "");

    if (!normalizedEmail || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    if (password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    const existingUser = await messageStore.getUserByEmail(normalizedEmail);
    if (existingUser) {
      return c.json({ error: "An account with this email already exists. Please sign in instead." }, 409);
    }

    const passwordDetails = hashPassword(password);
    const user = await messageStore.saveUser({
      id: randomBytes(16).toString("hex"),
      email: normalizedEmail,
      name: name?.trim() || normalizedEmail.split("@")[0],
      ...passwordDetails,
      createdAt: new Date().toISOString(),
    });

    return c.json(authResponse(user));
  } catch (error) {
    console.error("Error in signup endpoint:", error);
    return c.json({ error: error instanceof Error ? error.message : "Failed to sign up" }, 500);
  }
});

app.post("/signin", async (c) => {
  try {
    const { email, password } = await c.req.json<{ email?: string; password?: string }>();
    const normalizedEmail = normalizeEmail(email || "");

    if (!normalizedEmail || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const user = await messageStore.getUserByEmail(normalizedEmail);
    if (!user || !verifyPassword(password, user)) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    return c.json(authResponse(user));
  } catch (error) {
    console.error("Error in signin endpoint:", error);
    return c.json({ error: error instanceof Error ? error.message : "Failed to sign in" }, 500);
  }
});

app.get("/auth/me", (c) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const user = token ? verifyToken(token) : null;

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: {
      id: user.sub,
      email: user.email,
      user_metadata: {
        name: user.name,
      },
    },
  });
});

app.get("/messages/:userId", async (c) => {
  const userId = c.req.param("userId");
  const messages = await messageStore.listMessages(userId);
  return c.json({ messages });
});

app.post("/messages/:userId", async (c) => {
  const userId = c.req.param("userId");
  const body = await c.req.json<StoredMessage>();
  const { id, role, content, timestamp } = body;

  if (!userId || !id || !role || !content || !timestamp) {
    return c.json({ error: "Missing required fields: userId, id, role, content, timestamp" }, 400);
  }

  const message = await messageStore.saveMessage(userId, body);
  return c.json({ success: true, message });
});

app.put("/messages/:userId/:messageId/feedback", async (c) => {
  const userId = c.req.param("userId");
  const messageId = c.req.param("messageId");
  const { feedback } = await c.req.json<{ feedback?: string }>();

  if (typeof feedback !== "string") {
    return c.json({ error: "Feedback is required" }, 400);
  }

  const message = await messageStore.updateFeedback(userId, messageId, feedback);

  if (!message) {
    return c.json({ error: "Message not found" }, 404);
  }

  return c.json({ success: true, message });
});

app.delete("/messages/:userId", async (c) => {
  const userId = c.req.param("userId");
  await messageStore.deleteMessages(userId);
  return c.json({ success: true });
});

app.post("/chat", async (c) => {
  try {
    const { message, conversationHistory = [], files = [], provider = "openai" } = await c.req.json();

    if (!message) {
      return c.json({ error: "Message is required" }, 400);
    }

    const selectedProvider = normalizeProvider(provider);
    const { response, providerUsed, fallbackReason } = await runChatWithFallback(
      selectedProvider,
      message,
      conversationHistory,
      files,
    );

    return c.json({ response, provider: selectedProvider, providerUsed, fallbackReason });
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    return c.json({ error: error instanceof Error ? error.message : "Failed to process chat request" }, 500);
  }
});

app.post("/generate-image", async (c) => {
  try {
    const { prompt } = await c.req.json<{ prompt?: string }>();

    if (!prompt?.trim()) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return c.json({ error: "OpenAI API key not configured" }, 500);
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        quality: "medium",
        n: 1,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return c.json({ error: `OpenAI Image API error: ${errorData.error?.message || "Unknown error"}` }, 502);
    }

    const data = await response.json();
    const generatedImage = data.data?.[0];
    const imageUrl = generatedImage?.url || (generatedImage?.b64_json ? `data:image/png;base64,${generatedImage.b64_json}` : undefined);

    return c.json({
      imageUrl,
      revisedPrompt: generatedImage?.revised_prompt || prompt,
    });
  } catch (error) {
    console.error("Error generating image:", error);
    return c.json({ error: error instanceof Error ? error.message : "Failed to generate image" }, 500);
  }
});

const port = Number(process.env.PORT || 8080);

serve({
  fetch: app.fetch,
  port,
});

console.log(`AWS backend listening on port ${port}`);
