import { afterEach, expect, test } from "vitest";
import serverConfig from "./config";
import { InferenceClientFactory, EmbeddingClientFactory } from "./inference";

const original = serverConfig.mediaAi.hybridEnabled;
afterEach(() => {
  serverConfig.mediaAi.hybridEnabled = original;
});

test("hybrid mode disables legacy inference and embedding paths that lack payload admission", () => {
  serverConfig.mediaAi.hybridEnabled = true;
  expect(InferenceClientFactory.build()).toBeNull();
  expect(EmbeddingClientFactory.build()).toBeNull();
});
