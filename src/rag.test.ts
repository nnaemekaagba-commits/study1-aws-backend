import assert from "node:assert/strict";
import test from "node:test";
import { retrieveRelevantHistory, type RagMessage } from "./rag.js";

const history: RagMessage[] = [
  { role: "user", content: "Explain the Carnot cycle" },
  { role: "assistant", content: "The Carnot cycle has two isothermal and two adiabatic stages." },
  { role: "user", content: "How do I multiply matrices?" },
  { role: "assistant", content: "Use row by column multiplication." },
  { role: "user", content: "What determines Carnot efficiency?" },
  { role: "assistant", content: "Carnot efficiency depends on hot and cold reservoir temperatures." },
];

test("retrieves relevant older context and preserves chronological order", () => {
  const result = retrieveRelevantHistory(history, "Tell me more about Carnot temperature efficiency", {
    maxMessages: 4,
    recentMessages: 2,
  });

  assert.equal(result.length, 4);
  assert.match(result[0].content, /Carnot cycle/i);
  assert.match(result[1].content, /isothermal/i);
  assert.match(result[3].content, /reservoir temperatures/i);
});

test("removes a duplicate current prompt from stored history", () => {
  const query = "Continue explaining Carnot efficiency";
  const result = retrieveRelevantHistory([...history, { role: "user", content: query }], query);
  assert.equal(result.some((message) => message.content === query), false);
});

test("respects character and message limits", () => {
  const result = retrieveRelevantHistory(history, "Carnot", { maxMessages: 3, maxChars: 55, recentMessages: 1 });
  assert.ok(result.length <= 3);
  assert.ok(result.reduce((sum, message) => sum + message.content.length, 0) <= 55);
});
