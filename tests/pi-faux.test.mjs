import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

test("drives the Pi AgentSession tool loop through a local Faux Provider", async () => {
  const faux = fauxProvider({ api: "faux:repo-sentinel-test" });
  const model = faux.getModel();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    streamSimple: faux.provider.streamSimple,
    models: faux.models.map((item) => ({
      id: item.id,
      name: item.name,
      api: item.api,
      reasoning: item.reasoning,
      input: item.input,
      cost: item.cost,
      contextWindow: item.contextWindow,
      maxTokens: item.maxTokens,
      baseUrl: item.baseUrl,
    })),
  });

  const recordedEvidence = [];
  const recordEvidence = defineTool({
    name: "record_evidence",
    label: "Record Evidence",
    description: "Record a reviewed evidence reference.",
    promptSnippet: "Record the evidence reference.",
    parameters: Type.Object({ evidence: Type.String() }),
    execute: async (_id, params) => {
      recordedEvidence.push(params.evidence);
      return { content: [{ type: "text", text: "evidence recorded" }], details: {} };
    },
  });

  faux.setResponses([
    fauxAssistantMessage([
      fauxText("I will record the evidence."),
      fauxToolCall("record_evidence", { evidence: "diff:src/review.ts" }, { id: "faux-record-evidence" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Evidence recorded; review complete.")),
  ]);

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    sessionManager: SessionManager.inMemory(process.cwd()),
    noTools: "all",
    tools: ["record_evidence"],
    customTools: [recordEvidence],
  });
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    await session.prompt("Inspect the change and record the evidence.");
  } finally {
    unsubscribe();
    session.dispose();
  }

  assert.deepEqual(recordedEvidence, ["diff:src/review.ts"]);
  assert.equal(faux.state.callCount, 2);
  assert.equal(faux.getPendingResponseCount(), 0);
  assert.equal(events.filter((event) => event.type === "tool_execution_start" && event.toolName === "record_evidence").length, 1);

  const assistantMessages = events
    .filter((event) => event.type === "message_end" && event.message.role === "assistant")
    .map((event) => event.message);
  assert.equal(assistantMessages.length, 2);
  assert.equal(assistantMessages[1].stopReason, "stop");
  assert.ok(assistantMessages.every((message) => message.usage.input > 0 && message.usage.output > 0));
  assert.ok(assistantMessages.some((message) => message.usage.cacheRead > 0));

  const eventTypes = events.map((event) => event.type);
  const settledAt = eventTypes.lastIndexOf("agent_settled");
  assert.ok(settledAt > eventTypes.lastIndexOf("agent_end"));
});
