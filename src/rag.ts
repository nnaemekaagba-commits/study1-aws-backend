export type RagMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

export type RagOptions = {
  maxMessages?: number;
  maxChars?: number;
  recentMessages?: number;
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from",
  "had", "has", "have", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or",
  "our", "so", "that", "the", "their", "then", "this", "to", "was", "we", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your",
]);

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function tokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function overlapScore(queryTokens: Set<string>, content: string) {
  if (queryTokens.size === 0) return 0;
  const contentTokens = tokens(content);
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

export function retrieveRelevantHistory(
  messages: RagMessage[],
  query: string,
  options: RagOptions = {},
) {
  const maxMessages = positiveInteger(options.maxMessages, 8);
  const maxChars = positiveInteger(options.maxChars, 8_000);
  const recentMessages = Math.min(positiveInteger(options.recentMessages, 4), maxMessages);
  const normalizedQuery = query.trim().toLowerCase();

  const candidates = messages
    .filter((message): message is RagMessage =>
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0,
    )
    .map((message, index) => ({ ...message, content: message.content.trim(), index }))
    .filter((message, index, all) => {
      const isLatestDuplicate = index >= Math.max(0, all.length - 2) &&
        message.role === "user" &&
        message.content.toLowerCase() === normalizedQuery;
      return !isLatestDuplicate;
    });

  if (candidates.length === 0) return [];

  const recent = candidates.slice(-recentMessages);
  const recentIndexes = new Set(recent.map((message) => message.index));
  const queryTokens = tokens(query);
  const remainingSlots = Math.max(0, maxMessages - recent.length);

  const relevant = candidates
    .filter((message) => !recentIndexes.has(message.index))
    .map((message) => ({
      message,
      score: overlapScore(queryTokens, message.content) + (message.index / candidates.length) * 0.08,
    }))
    .filter(({ score }) => score > 0.08)
    .sort((a, b) => b.score - a.score || b.message.index - a.message.index)
    .slice(0, remainingSlots)
    .map(({ message }) => message);

  const selected = [...relevant, ...recent]
    .sort((a, b) => a.index - b.index)
    .slice(-maxMessages);

  const bounded: RagMessage[] = [];
  let chars = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index];
    const available = maxChars - chars;
    if (available <= 0) break;
    const content = message.content.length > available
      ? message.content.slice(0, available)
      : message.content;
    bounded.unshift({ role: message.role, content, timestamp: message.timestamp });
    chars += content.length;
  }

  return bounded;
}
