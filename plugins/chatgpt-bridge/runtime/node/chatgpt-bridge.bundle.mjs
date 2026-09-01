// src/bridge/bridge.ts
import { createHash as createHash2 } from "node:crypto";
import { resolve } from "node:path";

// src/bridge/journal.ts
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
var ARTIFACT_KEY = /^[a-f0-9]{64}$/;
var STALE_LOCK_MS = 3e4;
var BridgeJournalError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "BridgeJournalError";
  }
  code;
};
async function createOperationRecord(input) {
  const now = (input.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
  const handle = { ...input.handle, statePath: input.statePath };
  const record = {
    schemaVersion: 1,
    handle,
    requestSha256: input.requestSha256,
    phase: "prepared",
    selection: { ...input.selection },
    updatedAt: now
  };
  validateRecord(record, input.statePath);
  await mkdir(dirname(input.statePath), { recursive: true });
  try {
    await writeFile(input.statePath, serialize(record), { flag: "wx" });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new BridgeJournalError(
        "operation_exists",
        `Bridge operation already exists: ${basename(input.statePath)}`
      );
    }
    throw error;
  }
  return record;
}
async function readOperationRecord(statePath) {
  const raw = await readFile(statePath, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeJournalError("invalid_record", "Bridge operation record is not valid JSON.");
  }
  validateRecord(value, statePath);
  return value;
}
async function updateOperationRecord(input) {
  const lockPath = `${input.statePath}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const current = await readOperationRecord(input.statePath);
    if (current.phase !== input.expectedPhase) {
      throw new BridgeJournalError(
        "phase_conflict",
        `Expected bridge phase ${input.expectedPhase}, found ${current.phase}.`
      );
    }
    assertTransition(current.phase, input.phase);
    const uncertainty = input.uncertainty?.trim();
    if (input.phase === "uncertain" && !uncertainty) {
      throw new BridgeJournalError("uncertainty_required", "Uncertain operations require a reason.");
    }
    if (input.phase !== "uncertain" && input.uncertainty !== void 0) {
      throw new BridgeJournalError("unexpected_uncertainty", "Only uncertain operations may store a reason.");
    }
    const timestamp = (input.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
    const handle = mergeHandle(current.handle, input.handlePatch);
    const next = {
      ...current,
      handle,
      phase: input.phase,
      updatedAt: timestamp
    };
    if (input.phase === "uncertain") next.uncertainty = uncertainty;
    else delete next.uncertainty;
    validateRecord(next, input.statePath);
    const tempPath = join(dirname(input.statePath), `.${basename(input.statePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, serialize(next), { flag: "wx" });
      await rename(tempPath, input.statePath);
    } finally {
      await unlink(tempPath).catch(() => void 0);
    }
    return next;
  } finally {
    await releaseLock(lock);
  }
}
async function acquireLock(lockPath) {
  return acquireLease(lockPath);
}
async function acquireLease(lockPath) {
  const owner = randomUUID();
  try {
    await writeFile(lockPath, owner, { flag: "wx" });
    return { path: lockPath, owner };
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  let observed;
  try {
    observed = await readFile(lockPath, "utf8");
    if (!await isStale(lockPath)) throw operationBusy();
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return createContendedLock(lockPath, owner);
  }
  const claim = await acquireClaim(lockPath, observed);
  try {
    let current;
    try {
      current = await readFile(lockPath, "utf8");
      if (current !== observed || !await isStale(lockPath)) throw operationBusy();
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      return createContendedLock(lockPath, owner);
    }
    await unlink(lockPath);
    return createContendedLock(lockPath, owner);
  } finally {
    await unlinkIfOwned(claim);
  }
}
async function createContendedLock(lockPath, owner) {
  try {
    await writeFile(lockPath, owner, { flag: "wx" });
    return { path: lockPath, owner };
  } catch (error) {
    if (isNodeError(error, "EEXIST")) throw operationBusy();
    throw error;
  }
}
async function acquireClaim(lockPath, observedOwner) {
  const identity = createHash("sha256").update(observedOwner).digest("hex");
  return acquireLease(`${lockPath}.${identity}.claim`);
}
async function releaseLock(lock) {
  let claim;
  try {
    claim = await acquireClaim(lock.path, lock.owner);
  } catch (error) {
    if (error instanceof BridgeJournalError && error.code === "operation_busy") return;
    throw error;
  }
  try {
    await unlinkIfOwned(lock);
  } finally {
    await unlinkIfOwned(claim);
  }
}
async function unlinkIfOwned(lock) {
  try {
    if (await readFile(lock.path, "utf8") === lock.owner) await unlink(lock.path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}
async function isStale(lockPath) {
  return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
}
function operationBusy() {
  return new BridgeJournalError("operation_busy", "Bridge operation is being updated.");
}
function assertTransition(from, to) {
  if (from === to) return;
  const allowed = {
    prepared: ["submitted", "generating", "completed", "uncertain"],
    submitted: ["generating", "completed", "uncertain"],
    generating: ["completed", "uncertain"],
    completed: [],
    uncertain: ["submitted", "generating", "completed"]
  };
  if (!allowed[from].includes(to)) {
    throw new BridgeJournalError("invalid_transition", `Bridge phase cannot move from ${from} to ${to}.`);
  }
}
function mergeHandle(current, patch) {
  if (patch === void 0) return current;
  for (const key of ["userTurnId", "assistantTurnId"]) {
    if (current[key] !== void 0 && patch[key] !== void 0 && current[key] !== patch[key]) {
      throw new BridgeJournalError(
        "turn_binding_mismatch",
        `Bridge ${key} cannot change after it is recorded.`
      );
    }
  }
  if (current.promptPresentationSha256s !== void 0 && patch.promptPresentationSha256s !== void 0 && !sameStrings(current.promptPresentationSha256s, patch.promptPresentationSha256s)) {
    throw new BridgeJournalError(
      "presentation_binding_mismatch",
      "Bridge prompt presentation evidence cannot change after it is recorded."
    );
  }
  return { ...current, ...definedEntries(patch) };
}
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function definedEntries(value) {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== void 0)
  );
}
function validateRecord(value, statePath) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.handle)) {
    throw new BridgeJournalError("invalid_record", "Bridge operation record has an invalid schema.");
  }
  const handle = value.handle;
  if (handle.version !== 1 || typeof handle.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(handle.operationId) || typeof handle.promptSha256 !== "string" || !ARTIFACT_KEY.test(handle.promptSha256) || handle.attachmentCount !== void 0 && (typeof handle.attachmentCount !== "number" || !Number.isInteger(handle.attachmentCount) || handle.attachmentCount < 1) || !isOptionalPresentationHashes(handle.promptPresentationSha256s) || handle.renderedPromptSha256 !== void 0 && (typeof handle.renderedPromptSha256 !== "string" || !ARTIFACT_KEY.test(handle.renderedPromptSha256)) || !isOptionalTurnId(handle.userTurnId) || !isOptionalTurnId(handle.assistantTurnId)) {
    throw new BridgeJournalError("invalid_record", "Bridge operation handle is invalid.");
  }
  if (handle.statePath !== statePath) {
    throw new BridgeJournalError("record_binding_mismatch", "Bridge operation record path does not match its handle.");
  }
  if (!isPhase(value.phase) || typeof value.requestSha256 !== "string" || !ARTIFACT_KEY.test(value.requestSha256)) {
    throw new BridgeJournalError("invalid_record", "Bridge operation request hash or phase is invalid.");
  }
  if (!isRecord(value.selection) || !Object.values(value.selection).every((entry) => typeof entry === "string") || typeof value.updatedAt !== "string") {
    throw new BridgeJournalError("invalid_record", "Bridge operation metadata is invalid.");
  }
}
function isOptionalPresentationHashes(value) {
  return value === void 0 || Array.isArray(value) && value.length >= 1 && value.length <= 4 && new Set(value).size === value.length && value.every((entry) => typeof entry === "string" && ARTIFACT_KEY.test(entry));
}
function isOptionalTurnId(value) {
  return value === void 0 || typeof value === "string" && /^[^\u0000-\u001f]{1,512}$/.test(value);
}
function isPhase(value) {
  return value === "prepared" || value === "submitted" || value === "generating" || value === "completed" || value === "uncertain";
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function serialize(record) {
  return `${JSON.stringify(record, null, 2)}
`;
}

// src/bridge/output.ts
async function collectBridgeOutput(port, options = {}) {
  const markdown = await port.copyResponseMarkdown().catch(() => void 0);
  const [response, inventory] = await Promise.all([
    markdown === void 0 ? port.readResponseSnapshot() : void 0,
    port.listArtifacts()
  ]);
  const artifacts = await collectArtifacts(port, uniqueArtifacts(inventory), options.downloadDir);
  const output = markdown !== void 0 ? { markdown, fidelity: "clipboard_markdown", artifacts } : {
    ...response?.text === void 0 ? {} : { text: response.text },
    fidelity: "dom_text",
    artifacts
  };
  if (response?.partial !== void 0) output.partial = response.partial;
  return output;
}
async function collectArtifacts(port, artifacts, downloadDir) {
  const collected = [];
  for (const observed of artifacts) {
    const metadata = withoutKey(observed);
    if (downloadDir === void 0 || port.downloadArtifact === void 0) {
      collected.push({ ...metadata, transfer: { status: "not_requested" } });
      continue;
    }
    try {
      const downloaded = await port.downloadArtifact(observed, downloadDir);
      collected.push({ ...metadata, ...downloaded, transfer: { status: "downloaded" } });
    } catch (error) {
      collected.push({
        ...metadata,
        transfer: { status: "failed", code: artifactTransferFailureCode(error) }
      });
    }
  }
  return collected;
}
function uniqueArtifacts(artifacts) {
  const seen = /* @__PURE__ */ new Set();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.key)) return false;
    seen.add(artifact.key);
    return true;
  });
}
function withoutKey(artifact) {
  const { key: _key, ...metadata } = artifact;
  return metadata;
}
function artifactTransferFailureCode(error) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : void 0;
  return code === "artifact_preview_timeout" || code === "artifact_download_unavailable" ? code : "artifact_transfer_failed";
}

// src/bridge/targets.ts
var BridgeTargetSelectionError = class extends Error {
  code;
  axis;
  value;
  constructor(code, axis, value, message) {
    super(message);
    this.name = "BridgeTargetSelectionError";
    this.code = code;
    this.axis = axis;
    this.value = value;
  }
};
async function selectTargets(port, requested) {
  const before = await port.inspectTargets();
  const plan = Object.entries(requested).map(
    ([axis, value]) => planSelection(before, axis, value)
  );
  if (plan.length === 0) {
    return before;
  }
  let changed = false;
  for (const item of plan) {
    const alreadySelected = before.active[item.axis] === item.value && item.option.selected;
    if (!alreadySelected) {
      await port.selectTarget(item.axis, item.value);
      changed = true;
    }
  }
  if (!changed) return before;
  const after = await port.inspectTargets();
  verifyTargets(after, requested);
  return after;
}
function verifyTargets(snapshot2, requested) {
  for (const [axis, value] of Object.entries(requested)) {
    verifySelection(snapshot2, axis, value);
  }
}
function planSelection(snapshot2, axis, value) {
  const options = snapshot2.options[axis];
  if (options === void 0) {
    throw new BridgeTargetSelectionError(
      "target_axis_unavailable",
      axis,
      value,
      `Target axis ${JSON.stringify(axis)} is not visible.`
    );
  }
  const matches = options.filter((option2) => option2.label === value);
  if (matches.length === 0) {
    throw new BridgeTargetSelectionError(
      "target_value_unavailable",
      axis,
      value,
      `Target ${JSON.stringify(value)} is not visible on axis ${JSON.stringify(axis)}.`
    );
  }
  if (matches.length !== 1) {
    throw new BridgeTargetSelectionError(
      "target_value_ambiguous",
      axis,
      value,
      `Target ${JSON.stringify(value)} is ambiguous on axis ${JSON.stringify(axis)}.`
    );
  }
  const option = matches[0];
  if (option.disabled === true) {
    throw new BridgeTargetSelectionError(
      "target_value_disabled",
      axis,
      value,
      `Target ${JSON.stringify(value)} is disabled on axis ${JSON.stringify(axis)}.`
    );
  }
  return { axis, value, option };
}
function verifySelection(snapshot2, axis, value) {
  const matches = snapshot2.options[axis]?.filter(
    (option) => option.label === value
  );
  const verified = matches?.length === 1 && matches[0]?.disabled !== true && matches[0]?.selected === true && snapshot2.active[axis] === value;
  if (!verified) {
    throw new BridgeTargetSelectionError(
      "target_unverified",
      axis,
      value,
      `Target ${JSON.stringify(value)} was not verified on axis ${JSON.stringify(axis)}.`
    );
  }
}

// src/bridge/bridge.ts
function createBridge(options) {
  const stateDir = resolve(options.stateDir ?? ".codex/chatgpt-bridge/operations");
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const sleep = options.sleep ?? delay;
  let portTail = Promise.resolve();
  async function withPort(work) {
    const previous = portTail;
    let release;
    portTail = new Promise((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async function submit(input) {
    assertPrompt(input.prompt);
    const operationId = input.operationId;
    assertOperationId(operationId);
    const statePath = resolve(stateDir, `${operationId}.json`);
    const requestSha256 = requestHash(input);
    const existing = await readIfExists(statePath);
    if (existing !== void 0) {
      verifySameRequest(existing, requestSha256);
      return resultFromRecord(existing);
    }
    return withPort(async () => {
      const queuedExisting = await readIfExists(statePath);
      if (queuedExisting !== void 0) {
        verifySameRequest(queuedExisting, requestSha256);
        return resultFromRecord(queuedExisting);
      }
      if ((input.files?.length ?? 0) > 0) {
        await options.port.preflightFiles(input.files);
      }
      const createdAt = now().toISOString();
      const binding = await options.port.bindThread(input.thread ?? "new");
      const requestedSelection = input.selection ?? {};
      if (Object.keys(requestedSelection).length > 0) {
        await selectTargets(options.port, requestedSelection);
      }
      await options.port.composePrompt(input.prompt);
      for (const tool of input.tools ?? []) await options.port.selectTool(tool);
      const hasFiles = (input.files?.length ?? 0) > 0;
      const preHandoffPresentation = await options.port.submissionPresentationSha256s(input.prompt);
      const handle = {
        version: 1,
        operationId,
        promptSha256: sha256(input.prompt),
        ...!hasFiles ? {} : { attachmentCount: input.files.length },
        ...!hasFiles ? { promptPresentationSha256s: [...preHandoffPresentation] } : {},
        createdAt,
        statePath,
        ...binding.threadUrl === void 0 ? {} : { threadUrl: binding.threadUrl },
        ...binding.conversationId === void 0 ? {} : { conversationId: binding.conversationId },
        ...binding.tabId === void 0 ? {} : { tabId: binding.tabId },
        userTurnBefore: binding.userTurnCount,
        assistantTurnBefore: binding.assistantTurnCount
      };
      try {
        await createOperationRecord({
          statePath,
          handle,
          requestSha256,
          selection: requestedSelection,
          now
        });
      } catch (error) {
        if (!(error instanceof BridgeJournalError) || error.code !== "operation_exists") throw error;
        const winner = await readOperationRecord(statePath);
        verifySameRequest(winner, requestSha256);
        return resultFromRecord(winner);
      }
      try {
        if (hasFiles) {
          await options.port.attachFiles(input.files);
          const presentationSha256s = await options.port.submissionPresentationSha256s(input.prompt);
          await updateOperationRecord({
            statePath,
            expectedPhase: "prepared",
            phase: "prepared",
            handlePatch: { promptPresentationSha256s: [...presentationSha256s] },
            now
          });
        }
      } catch (error) {
        const uncertain2 = await updateOperationRecord({
          statePath,
          expectedPhase: "prepared",
          phase: "uncertain",
          uncertainty: preparationUncertainty(error),
          now
        });
        return resultFromRecord(uncertain2);
      }
      let submission;
      try {
        submission = await options.port.submitPrompt({
          prompt: input.prompt,
          promptSha256: handle.promptSha256,
          userTurnBefore: binding.userTurnCount,
          assistantTurnBefore: binding.assistantTurnCount,
          ...binding.lastUserTurnId === void 0 ? {} : { lastUserTurnId: binding.lastUserTurnId },
          ...binding.lastAssistantTurnId === void 0 ? {} : { lastAssistantTurnId: binding.lastAssistantTurnId },
          ...requestedSelection.power === void 0 ? {} : { power: requestedSelection.power }
        });
      } catch {
        const uncertain2 = await updateOperationRecord({
          statePath,
          expectedPhase: "prepared",
          phase: "uncertain",
          uncertainty: "Send outcome could not be reconciled after at most one activation.",
          now
        });
        return resultFromRecord(uncertain2);
      }
      const handlePatch = {
        ...submission.threadUrl === void 0 ? {} : { threadUrl: submission.threadUrl },
        ...submission.conversationId === void 0 ? {} : { conversationId: submission.conversationId },
        ...submission.tabId === void 0 ? {} : { tabId: submission.tabId },
        ...submission.renderedPromptSha256 === void 0 ? {} : { renderedPromptSha256: submission.renderedPromptSha256 },
        ...submission.userTurnId === void 0 ? {} : { userTurnId: submission.userTurnId }
      };
      const record = submission.confirmed ? await updateOperationRecord({
        statePath,
        expectedPhase: "prepared",
        phase: "submitted",
        handlePatch,
        now
      }) : await updateOperationRecord({
        statePath,
        expectedPhase: "prepared",
        phase: "uncertain",
        handlePatch,
        uncertainty: "Send was attempted once but the visible user turn could not be confirmed.",
        now
      });
      return resultFromRecord(record);
    });
  }
  async function refresh(handle, capture) {
    return withPort(async () => {
      const record = await boundRecord(handle);
      if (record.phase === "completed") {
        if (capture === void 0) return resultFromRecord(record);
        await options.port.bindHandle(record.handle);
        const output2 = await collectBridgeOutput(options.port, capture);
        return { ...resultFromRecord(record), output: output2 };
      }
      if (record.phase === "uncertain" && preparationBlockerCode(record.uncertainty) !== void 0) {
        return resultFromRecord(record);
      }
      let binding;
      let observation;
      try {
        binding = await options.port.bindHandle(record.handle);
        observation = await options.port.observe(record.handle);
      } catch {
        if (record.phase === "uncertain") return resultFromRecord(record);
        const uncertain2 = await updateOperationRecord({
          statePath: requireStatePath(record.handle),
          expectedPhase: record.phase,
          phase: "uncertain",
          uncertainty: "Visible handle could not be reconciled.",
          now
        });
        return resultFromRecord(uncertain2);
      }
      const phase = trustedObservedPhase(observation);
      const handlePatch = changedBindingPatch(record.handle, binding, observation);
      if (phase === record.phase && Object.keys(handlePatch).length === 0) {
        return resultFromRecord(record);
      }
      const next = await updateOperationRecord({
        statePath: requireStatePath(record.handle),
        expectedPhase: record.phase,
        phase,
        handlePatch,
        ...phase === "uncertain" ? { uncertainty: observation.uncertainty ?? "Visible turn ownership could not be verified." } : {},
        now
      });
      const result = resultFromRecord(next);
      if (next.phase !== "completed" || capture === void 0) return result;
      await options.port.bindHandle(next.handle);
      const output = await collectBridgeOutput(options.port, capture);
      return { ...result, output };
    });
  }
  async function collect(handle, resumeOptions = {}) {
    const capture = {
      ...resumeOptions.downloadDir === void 0 ? {} : { downloadDir: resumeOptions.downloadDir }
    };
    let current = await refresh(handle, capture);
    const wait = normalizeWait(resumeOptions.wait);
    if (wait !== void 0) {
      const started = now().getTime();
      while (isRunning(current.phase) && now().getTime() - started < wait.timeoutMs) {
        const remaining = wait.timeoutMs - (now().getTime() - started);
        await sleep(Math.min(wait.pollMs, remaining));
        current = await refresh(current.handle, capture);
      }
    }
    return current;
  }
  async function run(input) {
    const submitted = await submit(input);
    if (submitted.phase === "uncertain" || input.wait === false) return submitted;
    return collect(submitted.handle, {
      wait: input.wait ?? true,
      ...input.downloadDir === void 0 ? {} : { downloadDir: input.downloadDir }
    });
  }
  async function boundRecord(handle) {
    const record = await readOperationRecord(requireStatePath(handle));
    if (record.handle.operationId !== handle.operationId || record.handle.promptSha256 !== handle.promptSha256 || record.handle.createdAt !== handle.createdAt) {
      throw new Error("Bridge handle does not match its durable operation record.");
    }
    return record;
  }
  return {
    inspectTargets: () => withPort(() => options.port.inspectTargets()),
    submit,
    collect,
    run
  };
}
function trustedObservedPhase(observation) {
  return observation.phase === "completed" && !observation.responseOwned ? "uncertain" : observation.phase;
}
function resultFromRecord(record) {
  const result = { phase: record.phase, handle: record.handle };
  if (record.phase !== "uncertain" && Object.keys(record.selection).length > 0) {
    result.selection = {
      requested: record.selection,
      active: record.selection,
      verified: true
    };
  }
  if (record.phase === "uncertain") {
    const preparationCode = preparationBlockerCode(record.uncertainty);
    result.blocker = preparationCode === void 0 ? {
      code: "operation_uncertain",
      message: record.uncertainty ?? "Visible submission ownership is uncertain.",
      resumable: true
    } : {
      code: preparationCode,
      message: "Visible preparation could not be completed safely.",
      resumable: false
    };
  }
  return result;
}
function normalizeWait(wait) {
  if (wait === false || wait === void 0) return void 0;
  if (wait === true) return { timeoutMs: 12e4, pollMs: 1e3 };
  return {
    timeoutMs: positive(wait.timeoutMs, 12e4),
    pollMs: positive(wait.pollMs, 1e3)
  };
}
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}
function isRunning(phase) {
  return phase === "prepared" || phase === "submitted" || phase === "generating";
}
function requireStatePath(handle) {
  if (handle.statePath === void 0) throw new Error("Bridge handle has no durable state path.");
  return handle.statePath;
}
function assertPrompt(prompt) {
  if (prompt.trim().length === 0) throw new Error("Bridge prompt must contain visible text.");
}
function assertOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw new Error("Bridge operation ID must be a path-safe opaque identifier.");
  }
}
function changedBindingPatch(handle, binding, observation) {
  const patch = {};
  if (binding.threadUrl !== void 0 && binding.threadUrl !== handle.threadUrl) patch.threadUrl = binding.threadUrl;
  if (binding.conversationId !== void 0 && binding.conversationId !== handle.conversationId) patch.conversationId = binding.conversationId;
  if (binding.tabId !== void 0 && binding.tabId !== handle.tabId) patch.tabId = binding.tabId;
  if (observation.userTurnId !== void 0 && observation.userTurnId !== handle.userTurnId) {
    patch.userTurnId = observation.userTurnId;
  }
  if (observation.phase === "completed" && observation.assistantTurnId !== void 0 && observation.assistantTurnId !== handle.assistantTurnId) {
    patch.assistantTurnId = observation.assistantTurnId;
  }
  return patch;
}
function requestHash(input) {
  const sortedSelection = Object.fromEntries(
    Object.entries(input.selection ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  return sha256(JSON.stringify({
    promptSha256: sha256(input.prompt),
    thread: input.thread ?? "new",
    selection: sortedSelection,
    tools: input.tools ?? [],
    files: input.files ?? []
  }));
}
async function readIfExists(statePath) {
  try {
    return await readOperationRecord(statePath);
  } catch (error) {
    if (isNodeError2(error, "ENOENT")) return void 0;
    throw error;
  }
}
function verifySameRequest(record, requestSha256) {
  if (record.requestSha256 !== requestSha256) {
    throw new Error("Bridge operation ID is already bound to a different request.");
  }
}
function preparationUncertainty(error) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && SAFE_PREPARATION_CODES.has(error.code) ? error.code : void 0;
  return code ?? "preparation_uncertain";
}
function preparationBlockerCode(uncertainty) {
  return uncertainty !== void 0 && SAFE_PREPARATION_CODES.has(uncertainty) ? uncertainty : void 0;
}
var SAFE_PREPARATION_CODES = /* @__PURE__ */ new Set([
  "preparation_uncertain",
  "file_path_not_absolute",
  "file_not_readable",
  "file_not_regular",
  "composer_unavailable",
  "input_ambiguous",
  "upload_path_unavailable",
  "file_handoff_uncertain",
  "upload_readiness_uncertain",
  "tool_label_invalid",
  "tool_unavailable",
  "tool_uncertain",
  "tool_unverified"
]);
function isNodeError2(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sha256(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// src/bridge/browser-port.ts
import { createHash as createHash4 } from "node:crypto";

// src/bridge/browser-inputs.ts
import { constants } from "node:fs";
import { access, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { basename as basename2, extname, isAbsolute, resolve as resolve2 } from "node:path";
var COMPOSER_FORM_SELECTOR = "main form:has(#prompt-textarea), form:has(#prompt-textarea)";
var UPLOAD_INPUT_SELECTOR = "#upload-files";
var ADD_FILES_LABEL = "Add files and more";
var PROCESSING_TEXT = /\b(uploading|processing|attaching|preparing|reading|scanning|analyzing)\b/i;
var ATTACHMENT_STABLE_OBSERVATIONS = 4;
var ATTACHMENT_STABLE_POLL_MS = 500;
var BrowserInputError = class extends Error {
  code;
  uncertain;
  constructor(code, message, uncertain2 = false, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "BrowserInputError";
    this.code = code;
    this.uncertain = uncertain2;
  }
};
async function validateLocalFiles(paths) {
  const validated = [];
  for (const input of paths) {
    if (!isAbsolute(input)) {
      throw new BrowserInputError(
        "file_path_not_absolute",
        `File path must be absolute on the browser host: ${input}`
      );
    }
    const path = resolve2(input);
    let metadata;
    try {
      [metadata] = await Promise.all([
        stat2(path),
        access(path, constants.R_OK)
      ]);
    } catch (cause) {
      throw new BrowserInputError(
        "file_not_readable",
        `File must exist and be readable on the browser host: ${path}`,
        false,
        cause
      );
    }
    if (!metadata.isFile()) {
      throw new BrowserInputError(
        "file_not_regular",
        `File path is not a regular file: ${path}`
      );
    }
    validated.push({ path, name: basename2(path), bytes: metadata.size });
  }
  return validated;
}
async function attachFiles(page, paths, options = {}) {
  if (paths.length === 0) return [];
  const files = await validateLocalFiles(paths);
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  const baseline = await attachmentSnapshot(composer);
  if (baseline.cards.length > 0) {
    throw new BrowserInputError(
      "input_ambiguous",
      "Visible Chat composer already contains attachments."
    );
  }
  const timeoutMs = positive2(options.timeoutMs, 3e4);
  const pollMs = positive2(options.pollMs, 100);
  const capability = await page.capabilities?.get("cdp");
  if (!isCdpCapability(capability)) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      "The selected browser does not expose background file handoff."
    );
  }
  const input = composer.locator?.(UPLOAD_INPUT_SELECTOR);
  if (input === void 0 || await input.count() !== 1 || input.evaluate === void 0) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      `Composer ${JSON.stringify(UPLOAD_INPUT_SELECTOR)} was not uniquely available.`
    );
  }
  const inputShape = await input.evaluate((element) => ({
    type: element.type,
    multiple: element.multiple
  }));
  if (inputShape.type !== "file" || files.length > 1 && !inputShape.multiple) {
    throw new BrowserInputError(
      "upload_path_unavailable",
      "The exact composer file input cannot accept the requested handoff."
    );
  }
  const payload = await Promise.all(files.map(async (file) => ({
    name: file.name,
    base64: (await readFile2(file.path)).toString("base64")
  })));
  try {
    const result = await capability.send("Runtime.evaluate", {
      expression: directUploadExpression(payload),
      userGesture: true,
      awaitPromise: true,
      returnByValue: true
    }, { timeoutMs });
    if (!isExactUploadResult(result, files.map((file) => file.name))) {
      throw new Error("Background file handoff lacked its exact postcondition.");
    }
  } catch (cause) {
    throw uncertain(
      "file_handoff_uncertain",
      "Background file handoff had an uncertain outcome.",
      cause
    );
  }
  try {
    const names = await waitForReadyFilenames(
      page,
      composer,
      files,
      baseline,
      timeoutMs,
      pollMs
    );
    return files.map((file, index) => ({ ...file, name: names[index] }));
  } catch (cause) {
    throw uncertain(
      "upload_readiness_uncertain",
      "Attachment filename readiness could not be confirmed.",
      cause
    );
  }
}
function directUploadExpression(files) {
  return `(async () => {
  const composers = document.querySelectorAll(${JSON.stringify(COMPOSER_FORM_SELECTOR)});
  if (composers.length !== 1) throw new Error("Chat composer is not unique.");
  const inputs = composers[0].querySelectorAll(${JSON.stringify(UPLOAD_INPUT_SELECTOR)});
  if (inputs.length !== 1) throw new Error("Upload input is not unique.");
  const input = inputs[0];
  const transfer = new DataTransfer();
  for (const file of ${JSON.stringify(files)}) {
    const raw = atob(file.base64);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    transfer.items.add(new File([bytes], file.name));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { count: input.files.length, names: Array.from(input.files, file => file.name) };
})()`;
}
function isExactUploadResult(value, names) {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const result = value.result;
  if (typeof result !== "object" || result === null || !("value" in result)) return false;
  const uploaded = result.value;
  if (typeof uploaded !== "object" || uploaded === null) return false;
  const count = "count" in uploaded ? uploaded.count : void 0;
  const actual = "names" in uploaded ? uploaded.names : void 0;
  return count === names.length && Array.isArray(actual) && actual.length === names.length && actual.every((name, index) => name === names[index]);
}
async function selectTool(page, label) {
  if (label.trim().length === 0) {
    throw new BrowserInputError("tool_label_invalid", "Tool label must be nonempty.");
  }
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  if (await hasExactComposerTool(composer, label)) return;
  const opener = await uniqueVisible(
    page.getByRole("button", { name: ADD_FILES_LABEL, exact: true }),
    "tool_unavailable",
    `Visible ${JSON.stringify(ADD_FILES_LABEL)} button was not uniquely available.`
  );
  try {
    await opener.click();
  } catch (cause) {
    throw new BrowserInputError(
      "tool_uncertain",
      "Opening the visible tool menu had an uncertain outcome.",
      true,
      cause
    );
  }
  const row = await waitForUniqueVisible(
    page,
    page.getByText(label, { exact: true }),
    "input_ambiguous",
    `Exact primary tool label ${JSON.stringify(label)} was unavailable or ambiguous.`,
    3e3,
    100
  );
  try {
    await row.click();
  } catch (cause) {
    throw new BrowserInputError(
      "tool_uncertain",
      `Selecting exact tool ${JSON.stringify(label)} had an uncertain outcome.`,
      true,
      cause
    );
  }
  await verifyComposerTools(composer, [label]);
}
async function verifyVisibleTools(page, labels) {
  const composer = await uniqueVisible(
    page.locator(COMPOSER_FORM_SELECTOR),
    "composer_unavailable",
    "Visible Chat composer was not uniquely available."
  );
  await verifyComposerTools(composer, labels);
}
async function verifyComposerTools(composer, labels) {
  for (const label of labels) {
    if (!await hasExactComposerTool(composer, label)) {
      throw new BrowserInputError(
        "tool_unverified",
        `Tool ${JSON.stringify(label)} lacks an exact visible composer echo.`,
        true
      );
    }
  }
}
async function hasExactComposerTool(composer, label) {
  const button = composer.getByRole?.("button", { name: label, exact: true });
  const buttonCount = button === void 0 ? 0 : await button.count();
  if (buttonCount > 1) {
    throw new BrowserInputError(
      "input_ambiguous",
      `Exact active tool label ${JSON.stringify(label)} was ambiguous.`
    );
  }
  const buttonActive = buttonCount === 1 && await button.isVisible();
  if (composer.evaluate === void 0) return buttonActive;
  const inline = await composer.evaluate(
    (element) => Array.from(element.querySelectorAll("[data-inline-selection-pill][data-keyword]")).map((pill) => pill.getAttribute("data-keyword") ?? "").filter(Boolean)
  );
  const inlineCount = inline.filter((value) => value === label).length;
  if (inlineCount > 1) {
    throw new BrowserInputError(
      "input_ambiguous",
      `Exact inline tool label ${JSON.stringify(label)} was ambiguous.`
    );
  }
  return buttonActive || inlineCount === 1;
}
async function waitForReadyFilenames(page, composer, files, baseline, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let stableKey;
  let stableObservations = 0;
  while (Date.now() < deadline) {
    const current = await attachmentSnapshot(composer);
    const matched = matchAttachmentCards(current.cards, files);
    const status = lineDelta(current.lines, baseline.lines);
    if (matched !== void 0 && !matched.pending && !PROCESSING_TEXT.test(withoutMatchedNames(status, matched.names).join("\n"))) {
      const key = JSON.stringify(matched.names);
      if (key === stableKey) {
        stableObservations += 1;
      } else {
        stableKey = key;
        stableObservations = 1;
      }
      if (stableObservations >= ATTACHMENT_STABLE_OBSERVATIONS) return matched.names;
    } else {
      stableKey = void 0;
      stableObservations = 0;
    }
    const delay2 = stableKey === void 0 ? pollMs : ATTACHMENT_STABLE_POLL_MS;
    await pause(page, Math.min(delay2, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Visible attachment names did not remain ready and stable before timeout.");
}
async function attachmentSnapshot(composer) {
  if (typeof composer.evaluate !== "function") {
    throw new Error("Visible composer attachment state is unavailable.");
  }
  return composer.evaluate((element) => ({
    lines: (element.innerText ?? element.textContent ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    cards: Array.from(element.querySelectorAll(".truncate.font-semibold")).map((name) => {
      const container = name.parentElement?.parentElement;
      const spinner = container?.querySelector("svg[class*='animate-spin']");
      const bounds = spinner?.getBoundingClientRect();
      return {
        name: (name.textContent ?? "").trim(),
        pending: bounds !== void 0 && bounds.width > 0 && bounds.height > 0
      };
    }).filter((card) => card.name.length > 0)
  }));
}
function lineDelta(current, baseline) {
  const before = occurrences(baseline);
  return current.filter((line) => {
    const count = before.get(line) ?? 0;
    if (count === 0) return true;
    before.set(line, count - 1);
    return false;
  });
}
function matchAttachmentCards(cards, files) {
  const unmatched = [...cards];
  const names = [];
  let pending = false;
  for (const file of files) {
    const index = unmatched.findIndex((card) => displayedFileNameMatches(file.name, card.name));
    if (index < 0) return void 0;
    names.push(unmatched[index].name);
    pending ||= unmatched[index].pending;
    unmatched.splice(index, 1);
  }
  if (unmatched.length > 0) return void 0;
  return { names, pending };
}
function withoutMatchedNames(lines, names) {
  const matched = occurrences(names);
  return lines.filter((line) => {
    const count = matched.get(line) ?? 0;
    if (count === 0) return true;
    matched.set(line, count - 1);
    return false;
  });
}
function displayedFileNameMatches(requested, displayed) {
  if (displayed === requested) return true;
  const extension = extname(requested);
  const stem = extension.length === 0 ? requested : requested.slice(0, -extension.length);
  return new RegExp(`^${escapeRegex(stem)} ?\\([1-9]\\d*\\)${escapeRegex(extension)}$`).test(displayed);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function uniqueVisible(locator, code, message) {
  if (!await isUniqueVisible(locator)) throw new BrowserInputError(code, message);
  return locator;
}
async function waitForUniqueVisible(page, locator, code, message, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const count = await locator.count();
    if (count > 1) throw new BrowserInputError(code, message);
    if (count === 1 && await locator.isVisible()) return locator;
    await pause(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new BrowserInputError(code, message);
}
async function isUniqueVisible(locator) {
  return await locator.count() === 1 && await locator.isVisible();
}
function uncertain(code, message, cause) {
  return new BrowserInputError(code, message, true, cause);
}
function isCdpCapability(value) {
  return typeof value === "object" && value !== null && typeof value.send === "function";
}
function occurrences(values) {
  const counts = /* @__PURE__ */ new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
function positive2(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? value : fallback;
}
async function pause(page, ms) {
  if (page.waitForTimeout !== void 0) {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve4) => setTimeout(resolve4, ms));
}

// src/bridge/browser-output.ts
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants2, createReadStream } from "node:fs";
import { copyFile, mkdir as mkdir2, stat as stat3, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename3, join as join2, resolve as resolve3 } from "node:path";
var GENERATED_IMAGE_CONTAINER_SELECTOR = [
  '[data-testid*="generated-image"]',
  '[data-testid*="image-generation"]',
  '[data-testid="image-paragen-multigen"]'
].join(",");
async function readVisibleChatSnapshot(page, options = {}) {
  const raw = await page.evaluate((requested) => {
    const main = document.querySelector("main");
    if (main === null) {
      return {
        userCount: 0,
        assistantCount: 0,
        pageStopVisible: false,
        responseActionsVisible: false,
        artifactResponseVisible: false,
        artifactCandidates: []
      };
    }
    const visible = (element) => {
      if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
      const html = element;
      const style = window.getComputedStyle(html);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && html.getClientRects().length > 0;
    };
    const renderedText = (element) => {
      const innerText = element.innerText;
      return typeof innerText === "string" ? innerText : element.textContent ?? "";
    };
    const promptText = (element) => {
      const skipped = "[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]";
      const read = (parent) => {
        let text = "";
        let followsPill = false;
        for (const child of Array.from(parent.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const nested = child;
            if (nested.matches(skipped)) {
              followsPill ||= nested.matches("[data-inline-selection-pill]");
              continue;
            }
            if (nested.tagName === "BR") {
              text += "\n";
              followsPill = false;
              continue;
            }
            let value2 = read(nested);
            if (followsPill && value2.startsWith(" ")) value2 = value2.slice(1);
            text += value2;
            followsPill = false;
            continue;
          }
          if (child.nodeType !== Node.TEXT_NODE) continue;
          let value = child.textContent ?? "";
          if (followsPill && value.startsWith(" ")) value = value.slice(1);
          text += value;
          followsPill = false;
        }
        return text;
      };
      return read(element);
    };
    const turnContainer = (message) => message.closest('[data-testid^="conversation-turn-"]') ?? message.closest("article") ?? message.closest("[data-message-id]") ?? message.parentElement ?? message;
    const turnId = (message) => {
      const container = turnContainer(message);
      const testId = container.getAttribute("data-testid");
      return message.getAttribute("data-message-id") ?? container.getAttribute("data-message-id") ?? (/^conversation-turn-\d+$/.test(testId ?? "") ? testId : null) ?? null;
    };
    const fileName = (value, trustedFileControl) => {
      const normalized = value.replace(/\s+/g, " ").trim().replace(/^download\s+/i, "");
      if (!/^[^\\/\r\n]{1,255}$/.test(normalized) || normalized === "." || normalized === "..") return null;
      return trustedFileControl || /\.[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null;
    };
    const generatedImages = (assistant) => Array.from(assistant.querySelectorAll("img")).filter((image) => {
      if (!visible(image)) return false;
      return image.closest(requested.generatedImageContainerSelector) !== null;
    });
    const responseCopyControls = (assistant) => {
      const container = turnContainer(assistant);
      const exact = Array.from(container.querySelectorAll(
        'button[data-testid="copy-turn-action-button"]'
      )).filter(visible);
      if (exact.length > 0) return exact;
      return Array.from(container.querySelectorAll(
        'button[aria-label="Copy response"], button[aria-label="Copy"]'
      )).filter((button) => visible(button) && button.closest("pre, code, [data-testid*='code']") === null);
    };
    const users = Array.from(main.querySelectorAll('[data-message-author-role="user"]')).filter(visible);
    const turnSelector = '[data-testid^="conversation-turn-"]';
    const turns = Array.from(main.querySelectorAll(turnSelector)).filter(visible);
    const assistants = turns.flatMap((turn) => {
      const roleTurns = Array.from(
        turn.querySelectorAll('[data-message-author-role="assistant"]')
      ).filter(visible);
      if (roleTurns.length > 0) return roleTurns;
      return generatedImages(turn).length > 0 ? [turn] : [];
    });
    const looseAssistants = Array.from(
      main.querySelectorAll('[data-message-author-role="assistant"]')
    ).filter((assistant) => visible(assistant) && assistant.closest(turnSelector) === null);
    assistants.push(...looseAssistants);
    const user = requested.userIndex === void 0 ? void 0 : users[requested.userIndex];
    const requestedAssistant = requested.assistantIndex === void 0 ? void 0 : assistants[requested.assistantIndex];
    const promptBubbles = user === void 0 ? [] : Array.from(user.querySelectorAll(
      ".user-message-bubble-color .whitespace-pre-wrap"
    )).filter(visible);
    const userText = user === void 0 ? void 0 : promptBubbles.length === 1 ? promptText(promptBubbles[0]) : renderedText(user);
    const userTurnId = user === void 0 ? void 0 : turnId(user);
    const assistantText = requested.includeAssistantText === true && requestedAssistant !== void 0 ? renderedText(requestedAssistant) : void 0;
    const assistantTurnId = requestedAssistant === void 0 ? void 0 : turnId(requestedAssistant);
    const pageStopVisible = Array.from(main.querySelectorAll([
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]'
    ].join(","))).some(visible);
    const actionAssistant = requestedAssistant ?? assistants.at(-1);
    const responseActionsVisible = actionAssistant !== void 0 && responseCopyControls(actionAssistant).length === 1;
    const artifactResponseVisible = requestedAssistant !== void 0 && generatedImages(requestedAssistant).length > 0;
    const artifactCandidates = [];
    const artifactAssistants = requested.includeArtifacts !== true ? [] : requested.assistantIndex === void 0 ? assistants.map((assistant, assistantIndex) => ({ assistant, assistantIndex })) : requestedAssistant === void 0 ? [] : [{ assistant: requestedAssistant, assistantIndex: requested.assistantIndex }];
    artifactAssistants.forEach(({ assistant, assistantIndex }) => {
      const candidateTurnId = turnId(assistant);
      const controls = Array.from(assistant.querySelectorAll([
        "button[aria-label]",
        "a[download]",
        "a[href*='/files/']",
        "a[href*='/mnt/data/']",
        "a[href*='/backend-api/files/']"
      ].join(","))).filter(visible);
      controls.forEach((control, controlIndex) => {
        const href = control.getAttribute("href") ?? "";
        const trustedFileControl = control.hasAttribute("download") || href.includes("/files/") || href.includes("/mnt/data/") || href.includes("/backend-api/files/") || control.closest('[data-testid*="file" i], [data-testid*="artifact" i]') !== null;
        const controlLabel = (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/g, " ").trim();
        const name = fileName(controlLabel, trustedFileControl);
        const textName = fileName(control.textContent ?? "", trustedFileControl);
        if (name === null || textName !== name) return;
        const role = control.tagName.toLowerCase() === "a" ? "link" : "button";
        artifactCandidates.push({
          assistantIndex,
          assistantTurnId: candidateTurnId,
          kind: "file",
          name,
          occurrence: controlIndex,
          controlLabel,
          controlRole: role
        });
      });
      generatedImages(assistant).forEach((image, occurrence) => {
        artifactCandidates.push({
          assistantIndex,
          assistantTurnId: candidateTurnId,
          kind: "image",
          name: image.getAttribute("alt"),
          occurrence
        });
      });
    });
    return {
      userCount: users.length,
      assistantCount: assistants.length,
      ...userText === void 0 ? {} : { userText },
      ...userTurnId === void 0 ? {} : { userTurnId },
      ...assistantText === void 0 ? {} : { assistantText },
      ...assistantTurnId === void 0 ? {} : { assistantTurnId },
      pageStopVisible,
      responseActionsVisible,
      artifactResponseVisible,
      artifactCandidates
    };
  }, { ...options, generatedImageContainerSelector: GENERATED_IMAGE_CONTAINER_SELECTOR });
  const stopVisible = raw.pageStopVisible && stopBelongsToRequestedTurn(
    options,
    raw.userCount,
    raw.assistantCount
  );
  return {
    userCount: raw.userCount,
    assistantCount: raw.assistantCount,
    ...raw.userText === void 0 ? {} : { userText: raw.userText },
    ...raw.userTurnId === void 0 ? {} : { userTurnId: raw.userTurnId },
    ...raw.assistantText === void 0 ? {} : { assistantText: raw.assistantText },
    ...raw.assistantTurnId === void 0 ? {} : { assistantTurnId: raw.assistantTurnId },
    generation: {
      state: stopVisible ? "generating" : raw.responseActionsVisible || raw.artifactResponseVisible ? "completed" : "uncertain",
      stopVisible,
      responseActionsVisible: raw.responseActionsVisible
    },
    artifactCandidates: raw.artifactCandidates
  };
}
function stopBelongsToRequestedTurn(requested, userCount, assistantCount) {
  return requested.userIndex === void 0 || requested.assistantIndex === void 0 || requested.userIndex === userCount - 1 && (requested.assistantIndex === assistantCount || requested.assistantIndex === assistantCount - 1);
}
async function copyAssistantMarkdown(page, clipboard, target) {
  let control = await exactOwnedCopyControl(page, target);
  if (!control.ok) return { status: "unavailable", reason: control.reason };
  if (clipboard.snapshot === void 0 || clipboard.restore === void 0) {
    return { status: "unavailable", reason: "clipboard_unavailable" };
  }
  const clipboardSnapshot = await clipboard.snapshot();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const markdown = await attemptClipboardCopy(control.locator, clipboard);
      if (markdown !== void 0) return { status: "copied", markdown };
      if (attempt === 1) break;
      control = await exactOwnedCopyControl(page, target);
      if (!control.ok) return { status: "unavailable", reason: control.reason };
    }
    return { status: "unavailable", reason: "clipboard_unavailable" };
  } finally {
    await clipboard.restore(clipboardSnapshot);
  }
}
async function attemptClipboardCopy(control, clipboard) {
  let before;
  try {
    before = await clipboard.readText();
    if (clipboard.writeText !== void 0) {
      before = `codex-bridge-copy-${randomUUID2()}`;
      await clipboard.writeText(before);
    }
  } catch {
    return void 0;
  }
  await control.click().catch(() => void 0);
  try {
    const changed = clipboard.waitForChange === void 0 ? await clipboard.readText() : await clipboard.waitForChange(before, 3e3);
    return changed === void 0 || changed === before ? void 0 : changed;
  } catch {
    return void 0;
  }
}
async function exactOwnedCopyControl(page, target) {
  const assistants = await visibleLocators(
    page.locator?.('main [data-message-author-role="assistant"]')
  );
  const assistant = assistants[target.assistantIndex];
  if (assistant === void 0) return { ok: false, reason: "assistant_missing" };
  if (target.assistantTurnId !== void 0) {
    if (assistant.evaluate === void 0) return { ok: false, reason: "turn_mismatch" };
    const actualTurnId = await assistant.evaluate((element) => {
      const container2 = element.closest('[data-testid^="conversation-turn-"]') ?? element.closest("article") ?? element.closest("[data-message-id]") ?? element.parentElement ?? element;
      return element.getAttribute("data-message-id") ?? container2.getAttribute("data-message-id") ?? null;
    });
    if (actualTurnId !== target.assistantTurnId) return { ok: false, reason: "turn_mismatch" };
  }
  const container = await exactAssistantContainer(assistant);
  if (container === void 0) return { ok: false, reason: "copy_action_missing" };
  const exact = await visibleLocators(
    container.locator?.('button[data-testid="copy-turn-action-button"]')
  );
  let copies = exact;
  if (copies.length === 0) {
    const fallback = await visibleLocators(container.locator?.(
      'button[aria-label="Copy response"], button[aria-label="Copy"]'
    ));
    copies = [];
    for (const candidate of fallback) {
      if (candidate.evaluate === void 0) {
        return { ok: false, reason: "copy_action_ambiguous" };
      }
      const insideCode = await candidate.evaluate(
        (element) => element.closest("pre, code, [data-testid*='code']") !== null
      );
      if (!insideCode) copies.push(candidate);
    }
  }
  if (copies.length === 0) return { ok: false, reason: "copy_action_missing" };
  if (copies.length !== 1 || copies[0]?.click === void 0) {
    return { ok: false, reason: "copy_action_ambiguous" };
  }
  return { ok: true, locator: copies[0] };
}
async function exactAssistantContainer(assistant) {
  if (assistant.locator === void 0) return void 0;
  for (const selector of [
    "xpath=ancestor-or-self::*[starts-with(@data-testid, 'conversation-turn-')][1]",
    "xpath=ancestor-or-self::article[1]",
    "xpath=ancestor-or-self::*[@data-message-id][1]",
    "xpath=.."
  ]) {
    const candidate = assistant.locator(selector);
    if (await locatorCount(candidate) === 1) return candidate;
  }
  return void 0;
}
function readOwnedAssistantText(snapshot2, target) {
  if (target.assistantTurnId !== void 0 && snapshot2.assistantTurnId !== target.assistantTurnId) {
    return void 0;
  }
  return snapshot2.assistantText;
}
function inventoryHandleArtifacts(snapshot2, scope) {
  return snapshot2.artifactCandidates.filter((candidate) => candidate.assistantIndex === scope.assistantTurnBefore).map((candidate) => {
    const turn = candidate.assistantTurnId ?? `assistant-index:${candidate.assistantIndex}`;
    const key = createHash3("sha256").update(JSON.stringify([
      scope.operationId,
      scope.conversationId ?? null,
      turn,
      candidate.kind,
      candidate.kind === "file" ? candidate.name : null,
      candidate.controlLabel ?? null,
      candidate.occurrence
    ])).digest("hex");
    return {
      key,
      kind: candidate.kind,
      assistantIndex: candidate.assistantIndex,
      ...candidate.assistantTurnId === null ? {} : { assistantTurnId: candidate.assistantTurnId },
      ...candidate.name === null ? {} : { name: candidate.name },
      occurrence: candidate.occurrence,
      ...candidate.controlLabel === void 0 ? {} : { controlLabel: candidate.controlLabel },
      ...candidate.controlRole === void 0 ? {} : { controlRole: candidate.controlRole }
    };
  });
}
async function downloadHandleArtifact(page, artifact, downloadDir, timeoutMs = 12e4) {
  return artifact.kind === "image" ? downloadOwnedImage(page, artifact, downloadDir, boundedTimeout(timeoutMs)) : downloadOwnedFile(page, artifact, downloadDir, boundedTimeout(timeoutMs));
}
async function downloadOwnedImage(page, artifact, downloadDir, timeoutMs) {
  const requested = {
    assistantIndex: artifact.assistantIndex,
    ...artifact.assistantTurnId === void 0 ? {} : { assistantTurnId: artifact.assistantTurnId },
    occurrence: artifact.occurrence,
    timeoutMs,
    generatedImageContainerSelector: GENERATED_IMAGE_CONTAINER_SELECTOR
  };
  const rawCdp = await page.capabilities?.get?.("cdp");
  if (!isImageCdpCapability(rawCdp)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible browser does not expose bounded generated-image transfer."
    );
  }
  const result = await rawCdp.send("Runtime.evaluate", {
    expression: `(async () => {
    const requested = ${JSON.stringify(requested)};
    const visible = element => {
      if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden"
        && style.opacity !== "0" && element.getClientRects().length > 0;
    };
    const main = document.querySelector("main");
    if (main === null) return undefined;
    const turnSelector = '[data-testid^="conversation-turn-"]';
    const generated = element =>
      Array.from(element.querySelectorAll("img")).filter(image =>
        visible(image)
        && image.closest(requested.generatedImageContainerSelector) !== null
      );
    const turns = Array.from(main.querySelectorAll(turnSelector)).filter(visible);
    const assistants = turns.flatMap(turn => {
      const roleTurns = Array.from(
        turn.querySelectorAll('[data-message-author-role="assistant"]')
      ).filter(visible);
      if (roleTurns.length > 0) return roleTurns;
      return generated(turn).length > 0 ? [turn] : [];
    });
    assistants.push(...Array.from(
      main.querySelectorAll('[data-message-author-role="assistant"]')
    ).filter(assistant => visible(assistant) && assistant.closest(turnSelector) === null));
    const assistant = assistants[requested.assistantIndex];
    if (assistant === null) return undefined;
    if (assistant === undefined) return undefined;
    const container = assistant.closest('[data-testid^="conversation-turn-"]')
      ?? assistant.closest("article")
      ?? assistant.closest("[data-message-id]")
      ?? assistant.parentElement
      ?? assistant;
    const testId = container.getAttribute("data-testid");
    const turnId = assistant.getAttribute("data-message-id")
      ?? container.getAttribute("data-message-id")
      ?? (/^conversation-turn-\\d+$/.test(testId ?? "") ? testId : undefined)
      ?? undefined;
    if (requested.assistantTurnId !== undefined && turnId !== requested.assistantTurnId) {
      return undefined;
    }
    const images = generated(assistant);
    const image = images[requested.occurrence];
    if (image === undefined) return undefined;
    const src = image.currentSrc || image.src;
    const controller = new AbortController();
    let reader;
    const timer = setTimeout(() => {
      controller.abort();
      reader?.abort();
    }, requested.timeoutMs);
    return fetch(src, { signal: controller.signal }).then(async response => {
      if (!response.ok) return undefined;
      const blob = await response.blob();
      const dataUrl = await new Promise((resolveData, rejectData) => {
        reader = new FileReader();
        reader.onload = () => resolveData(String(reader.result));
        reader.onerror = () => rejectData(reader.error ?? new Error("Image read failed."));
        reader.onabort = () => rejectData(new Error("Image read timed out."));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, mimeType: blob.type || "image/png" };
    }).finally(() => clearTimeout(timer));
  })()`,
    userGesture: false,
    awaitPromise: true,
    returnByValue: true
  }, { timeoutMs });
  const source = cdpValue(result);
  if (source === void 0) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Exact owned image source is unavailable."
    );
  }
  if (!isImageSource(source)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Owned image transfer returned an unsupported shape."
    );
  }
  const encoded = /^data:([^;,]+);base64,(.+)$/s.exec(source.dataUrl);
  if (encoded?.[2] === void 0) throw new Error("Owned image did not produce base64 data.");
  const bytes = Buffer.from(encoded[2], "base64");
  if (bytes.length === 0) throw new Error("Owned image data is empty.");
  const extension = imageExtension(source.mimeType);
  const name = `generated-image-${artifact.key.slice(0, 12)}.${extension}`;
  const saved = await persistBuffer(downloadDir, name, artifact.key, bytes);
  return {
    ...saved,
    sha256: createHash3("sha256").update(bytes).digest("hex")
  };
}
function isImageCdpCapability(value) {
  return typeof value === "object" && value !== null && typeof value.send === "function";
}
function cdpValue(value) {
  if (typeof value !== "object" || value === null || !("result" in value)) return void 0;
  const result = value.result;
  return typeof result === "object" && result !== null && "value" in result ? result.value : void 0;
}
function isImageSource(value) {
  return typeof value === "object" && value !== null && "dataUrl" in value && typeof value.dataUrl === "string" && "mimeType" in value && typeof value.mimeType === "string";
}
async function downloadOwnedFile(page, artifact, downloadDir, timeoutMs) {
  if (artifact.name === void 0 || artifact.controlLabel === void 0 || artifact.controlRole === void 0 || page.locator === void 0) {
    throw new Error("Exact owned file control is unavailable.");
  }
  const assistants = page.locator('main [data-message-author-role="assistant"]');
  const assistant = await exactOccurrence(assistants, artifact.assistantIndex, "assistant turn");
  if (artifact.assistantTurnId !== void 0) {
    if (assistant.evaluate === void 0) throw new Error("Assistant turn identity cannot be verified.");
    const turnId = await assistant.evaluate((element) => {
      const container = element.closest('[data-testid^="conversation-turn-"]') ?? element.closest("article") ?? element.closest("[data-message-id]") ?? element.parentElement ?? element;
      return element.getAttribute("data-message-id") ?? container.getAttribute("data-message-id") ?? null;
    });
    if (turnId !== artifact.assistantTurnId) throw new Error("Owned file turn identity changed.");
  }
  const exactControls = assistant.getByRole?.(artifact.controlRole, {
    name: artifact.controlLabel,
    exact: true
  });
  const visibleControls = await visibleLocators(exactControls);
  if (visibleControls.length !== 1) {
    throw new Error("Owned file control is unavailable or ambiguous.");
  }
  const control = visibleControls[0];
  await verifyFileControl(control, artifact);
  if (artifact.controlRole === "link") {
    return downloadFromOneClick(page, control, downloadDir, artifact, timeoutMs);
  }
  if (control.click === void 0) throw new Error("Owned file preview control is not clickable.");
  await control.click();
  const exactDownload = await waitForExactPreviewDownload(page, artifact.name, timeoutMs);
  return downloadFromOneClick(page, exactDownload, downloadDir, artifact, timeoutMs);
}
async function waitForExactPreviewDownload(page, name, timeoutMs) {
  const preview = page.locator?.(`section[aria-label="${cssString(name)}"]`);
  const limitMs = Math.min(timeoutMs, 15e3);
  let waitedMs = 0;
  while (true) {
    const previews = await visibleLocators(preview);
    if (previews.length === 1) {
      const downloads = await visibleLocators(
        previews[0].getByRole?.("button", { name: "Download", exact: true })
      );
      if (downloads.length === 1 && downloads[0].click !== void 0) return downloads[0];
    }
    if (waitedMs >= limitMs) break;
    const delayMs = Math.min(100, limitMs - waitedMs);
    await waitForPage(page, delayMs);
    waitedMs += delayMs;
  }
  throw artifactTransferError(
    "artifact_preview_timeout",
    `Exact preview Download control for ${JSON.stringify(name)} was unavailable before timeout.`
  );
}
async function verifyFileControl(control, artifact) {
  if (control.evaluate === void 0) {
    throw new Error("Owned file control identity cannot be verified.");
  }
  const identity = await control.evaluate((element) => {
    const href = element.getAttribute("href") ?? "";
    return {
      role: element.tagName.toLowerCase() === "a" ? "link" : "button",
      label: (element.getAttribute("aria-label") ?? element.textContent ?? "").replace(/\s+/g, " ").trim(),
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
      trusted: element.hasAttribute("download") || href.includes("/files/") || href.includes("/mnt/data/") || href.includes("/backend-api/files/") || element.closest('[data-testid*="file" i], [data-testid*="artifact" i]') !== null
    };
  });
  const name = visibleFileName(identity.label, identity.trusted);
  const textName = visibleFileName(identity.text, identity.trusted);
  if (identity.role !== artifact.controlRole || identity.label !== artifact.controlLabel || name !== artifact.name || textName !== artifact.name) {
    throw new Error("Owned file control identity changed.");
  }
}
async function downloadFromOneClick(page, control, downloadDir, artifact, timeoutMs) {
  if (page.waitForEvent === void 0 || control.click === void 0) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible browser does not expose exact download events and clicks."
    );
  }
  const pending = page.waitForEvent("download", { timeoutMs });
  let clickError;
  try {
    await control.click();
  } catch (error) {
    clickError = error;
  }
  let raw;
  try {
    raw = await pending;
  } catch (error) {
    throw clickError ?? error;
  }
  if (!isDownload(raw)) {
    throw artifactTransferError(
      "artifact_download_unavailable",
      "Visible download event had an unsupported shape."
    );
  }
  const name = deterministicName(artifact.key, artifact.name ?? "artifact.bin");
  const directory = resolve3(downloadDir);
  await mkdir2(directory, { recursive: true });
  const target = join2(directory, name);
  const temporary = `${target}.${randomUUID2()}.partial`;
  try {
    const source = await raw.path({ timeoutMs });
    if (source === null) {
      throw artifactTransferError(
        "artifact_download_unavailable",
        "Download does not expose a completed local path."
      );
    }
    await copyFile(source, temporary);
    return await commitTemporaryArtifact(temporary, target, name);
  } finally {
    await unlink2(temporary).catch(() => void 0);
  }
}
async function persistBuffer(downloadDir, suggestedName, key, bytes) {
  const directory = resolve3(downloadDir);
  await mkdir2(directory, { recursive: true });
  const name = deterministicName(key, suggestedName);
  const target = join2(directory, name);
  const temporary = `${target}.${randomUUID2()}.partial`;
  try {
    await writeFile2(temporary, bytes, { flag: "wx" });
    return await commitTemporaryArtifact(temporary, target, name);
  } finally {
    await unlink2(temporary).catch(() => void 0);
  }
}
async function commitTemporaryArtifact(temporary, target, name) {
  try {
    await copyFile(temporary, target, constants2.COPYFILE_EXCL);
  } catch (error) {
    if (!isNodeError3(error, "EEXIST")) throw error;
    if (!await sameFile(temporary, target)) {
      throw new Error(`Artifact destination collision: ${target}`);
    }
  }
  return fileResult(target, name);
}
async function fileResult(path, name) {
  const metadata = await stat3(path);
  if (!metadata.isFile()) throw new Error(`Downloaded artifact is not a regular file: ${path}`);
  return {
    path,
    name,
    bytes: metadata.size,
    sha256: await fileSha256(path)
  };
}
async function exactOccurrence(locator, occurrence, label) {
  if (locator === void 0 || occurrence < 0) {
    throw new Error(`${label} occurrence ${occurrence} is unavailable.`);
  }
  const visible = await visibleLocators(locator);
  const selected = visible[occurrence];
  if (selected === void 0) throw new Error(`${label} occurrence ${occurrence} is unavailable.`);
  return selected;
}
async function visibleLocators(locator) {
  const count = await locatorCount(locator);
  if (locator === void 0) return [];
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? locator : locator.nth?.(index);
    if (candidate === void 0) {
      return [];
    }
    if (candidate.isVisible === void 0) {
      if (count > 1) return [];
      visible.push(candidate);
    } else if (await candidate.isVisible()) {
      visible.push(candidate);
    }
  }
  return visible;
}
async function locatorCount(locator) {
  return locator?.count === void 0 ? 0 : locator.count();
}
async function waitForPage(page, timeoutMs) {
  if (page.waitForTimeout !== void 0) {
    await page.waitForTimeout(timeoutMs);
    return;
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, timeoutMs));
}
async function sameFile(left, right) {
  const [leftStat, rightStat] = await Promise.all([stat3(left), stat3(right)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const [leftHash, rightHash] = await Promise.all([fileSha256(left), fileSha256(right)]);
  return leftHash === rightHash;
}
async function fileSha256(path) {
  const hash = createHash3("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function visibleFileName(value, trustedFileControl) {
  const normalized = value.replace(/\s+/g, " ").trim().replace(/^download\s+/i, "");
  if (!/^[^\\/\r\n]{1,255}$/.test(normalized) || normalized === "." || normalized === "..") return void 0;
  return trustedFileControl || /\.[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : void 0;
}
function boundedTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 12e4;
}
function isNodeError3(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function deterministicName(key, value) {
  const safe = basename3(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 180) || "artifact.bin";
  return `${key.slice(0, 12)}-${safe}`;
}
function imageExtension(mimeType) {
  if (/jpe?g/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "png";
}
function cssString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ");
}
function isDownload(value) {
  return typeof value === "object" && value !== null && typeof value.path === "function";
}
function artifactTransferError(code, message) {
  return Object.assign(new Error(message), { code });
}

// src/bridge/browser-runtime.ts
var CHATGPT_ORIGIN = "https://chatgpt.com";
var CHATGPT_HOME = `${CHATGPT_ORIGIN}/`;
var BrowserRuntimeError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "BrowserRuntimeError";
  }
  code;
};
async function acquireChatGPTPage(env, options = {}) {
  const browser = env.browser;
  let page;
  const expectedTabId = options.fresh === true ? void 0 : options.expectedTabId ?? env.expectedTabId;
  if (options.fresh === true && browser !== void 0) {
    page = await createHomePage(browser);
  } else if (expectedTabId !== void 0 && (env.page === void 0 || exactTabIdOrUndefined(env.page) !== expectedTabId)) {
    page = await exactBrowserTab(browser, expectedTabId);
  } else if (env.page !== void 0) {
    page = normalizeBrowserPage(env.page);
  } else {
    if (browser === void 0) {
      throw new BrowserRuntimeError(
        "browser_unavailable",
        "No selected visible browser is available from env.browser."
      );
    }
    page = await existingOrCreatedPage(browser, options.createIfMissing !== false);
  }
  const url = await exactChatGPTPageUrl(page);
  const tabId = exactTabId(page);
  if (expectedTabId !== void 0 && expectedTabId !== tabId) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(tabId)} does not match expected tab ${JSON.stringify(expectedTabId)}.`
    );
  }
  const auth = await readVisibleAuthState(page);
  if (auth === "login_required") {
    throw new BrowserRuntimeError(
      "login_required",
      "The visible ChatGPT page requires the user to sign in."
    );
  }
  if (browser !== void 0) env.browser = browser;
  env.page = page;
  env.expectedTabId = tabId;
  return {
    ...browser === void 0 ? {} : { browser },
    page,
    tabId,
    url,
    auth
  };
}
async function exactBrowserTab(browser, expectedTabId) {
  if (browser === void 0 || typeof browser.tabs?.get !== "function") {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(expectedTabId)} cannot be reclaimed.`
    );
  }
  let raw;
  try {
    raw = await browser.tabs.get(expectedTabId);
  } catch {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Controlled tab ${JSON.stringify(expectedTabId)} cannot be reclaimed.`
    );
  }
  const page = normalizeBrowserPage(raw);
  if (exactTabId(page) !== expectedTabId) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      `Reclaimed tab did not match ${JSON.stringify(expectedTabId)}.`
    );
  }
  return page;
}
function normalizeBrowserPage(raw) {
  if (!isRecord2(raw)) {
    throw new BrowserRuntimeError("page_unavailable", "Browser tab is not an object.");
  }
  const inner = isRecord2(raw.playwright) ? raw.playwright : raw;
  return new Proxy(inner, {
    get(target, property) {
      if (property === "url" || property === "title") {
        const value2 = property in target ? target[property] : raw[property];
        if (typeof value2 === "function") return value2.bind(property in target ? target : raw);
        if (typeof value2 === "string") return () => value2;
        return void 0;
      }
      const value = property in target ? target[property] : raw[property];
      return typeof value === "function" ? value.bind(property in target ? target : raw) : value;
    }
  });
}
function exactTabId(page) {
  const candidate = page.providerTabId ?? page.tabId ?? page.id;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new BrowserRuntimeError(
      "tab_id_unavailable",
      "Controlled ChatGPT page does not expose an exact tab ID."
    );
  }
  return candidate;
}
function exactChatGPTUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserRuntimeError("unsafe_origin", "Controlled page URL is invalid.");
  }
  if (parsed.origin !== CHATGPT_ORIGIN || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new BrowserRuntimeError(
      "unsafe_origin",
      `Visible bridge access requires the exact ${CHATGPT_ORIGIN} origin.`
    );
  }
  return parsed;
}
async function readVisibleAuthState(page) {
  if (typeof page.evaluate !== "function") return "unknown";
  try {
    const snapshot2 = await page.evaluate(() => {
      const messageSelector = "[data-message-author-role], [data-testid^='conversation-turn']";
      const visible = (element) => {
        if (element.closest("[hidden], [aria-hidden='true']") !== null) return false;
        const html = element;
        const style = window.getComputedStyle(html);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && element.getClientRects().length > 0;
      };
      const normalizedName = (element) => {
        const html = element;
        return (element.getAttribute("aria-label") ?? element.getAttribute("value") ?? html.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      };
      const accountSelector = [
        "[data-testid*='account' i]",
        "[data-testid*='profile' i]",
        "button[aria-label*='account' i]",
        "button[aria-label*='profile' i]"
      ].join(", ");
      const composerSelector = [
        "#prompt-textarea",
        "textarea[data-id='root']",
        "[contenteditable='true'][data-testid*='composer' i]"
      ].join(", ");
      const controls = Array.from(document.querySelectorAll(
        "button, a, [role='button'], input[type='button'], input[type='submit']"
      )).filter((element) => element.closest(messageSelector) === null && visible(element));
      return {
        account: Array.from(document.querySelectorAll(accountSelector)).some(visible),
        composer: Array.from(document.querySelectorAll(composerSelector)).some(visible),
        conversationLinks: Array.from(document.querySelectorAll("a[href^='/c/']")).filter(visible).length,
        messages: Array.from(document.querySelectorAll(messageSelector)).some(visible),
        login: controls.some((element) => {
          const name = normalizedName(element);
          return name === "log in" || name === "sign in";
        })
      };
    });
    if (!isAuthSnapshot(snapshot2)) return "unknown";
    if (snapshot2.login) return "login_required";
    const signedIn = snapshot2.account || snapshot2.conversationLinks > 0 && (snapshot2.composer || snapshot2.messages);
    return signedIn ? "signed_in" : "unknown";
  } catch {
    return "unknown";
  }
}
async function existingOrCreatedPage(browser, createIfMissing) {
  const listed = await Promise.resolve(browser.tabs?.list?.() ?? []);
  const matches = [];
  for (const tab of listed) {
    const page = await hydrateTab(browser, tab);
    const url = await readPageUrl(page);
    if (url !== void 0 && isExactChatGPTUrl(url)) matches.push(tab);
  }
  if (matches.length > 1) {
    throw new BrowserRuntimeError(
      "ambiguous_chatgpt_tabs",
      `Found ${matches.length} controlled ChatGPT tabs; bind an exact page instead of guessing.`
    );
  }
  if (matches.length === 1) return hydrateTab(browser, matches[0]);
  if (!createIfMissing) {
    throw new BrowserRuntimeError("page_unavailable", "No controlled ChatGPT tab is available.");
  }
  return createHomePage(browser);
}
async function createHomePage(browser) {
  let raw;
  if (typeof browser.tabs?.create === "function") {
    raw = await browser.tabs.create(CHATGPT_HOME);
  } else if (typeof browser.tabs?.new === "function") {
    raw = await browser.tabs.new(CHATGPT_HOME);
  } else if (typeof browser.newPage === "function") {
    raw = await browser.newPage();
  }
  if (raw === void 0) {
    throw new BrowserRuntimeError(
      "page_unavailable",
      "Visible browser does not expose controlled tab creation."
    );
  }
  const page = await hydrateTab(browser, raw);
  const initialUrl = await readPageUrl(page);
  if (initialUrl === void 0 || initialUrl === "" || initialUrl === "about:blank") {
    if (typeof page.goto !== "function") {
      throw new BrowserRuntimeError(
        "page_unavailable",
        "New controlled tab cannot navigate to ChatGPT home."
      );
    }
    await page.goto(CHATGPT_HOME);
  }
  await exactChatGPTPageUrl(page);
  exactTabId(page);
  return page;
}
async function hydrateTab(browser, raw) {
  if (!isRecord2(raw.playwright) && typeof raw.id === "string" && typeof browser.tabs?.get === "function") {
    try {
      return normalizeBrowserPage(await browser.tabs.get(raw.id));
    } catch {
    }
  }
  return normalizeBrowserPage(raw);
}
async function exactChatGPTPageUrl(page) {
  const value = await readPageUrl(page);
  if (value === void 0) {
    throw new BrowserRuntimeError("unsafe_origin", "Controlled page URL cannot be verified.");
  }
  return exactChatGPTUrl(value).toString();
}
async function readPageUrl(page) {
  if (typeof page.url !== "function") return void 0;
  try {
    const value = await page.url();
    return typeof value === "string" ? value : void 0;
  } catch {
    return void 0;
  }
}
function isExactChatGPTUrl(value) {
  try {
    exactChatGPTUrl(value);
    return true;
  } catch {
    return false;
  }
}
function exactTabIdOrUndefined(page) {
  try {
    return exactTabId(page);
  } catch {
    return void 0;
  }
}
function isAuthSnapshot(value) {
  if (!isRecord2(value)) return false;
  return typeof value.account === "boolean" && typeof value.composer === "boolean" && typeof value.conversationLinks === "number" && Number.isInteger(value.conversationLinks) && value.conversationLinks >= 0 && typeof value.messages === "boolean" && typeof value.login === "boolean";
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}

// src/bridge/browser-targets.ts
var POWER_AXIS = "power";
var MAX_POWER_POSITIONS = 64;
var POWER_CONTROL_SELECTOR = "[role='menuitem'][aria-label='Power']";
var POSITION_SUFFIX = /,\s*\d+\s+of\s+\d+\.\s*$/;
var BrowserPowerTargetError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "BrowserPowerTargetError";
    this.code = code;
  }
};
var ChatGPTPowerTargetPort = class {
  #page;
  #labels;
  constructor(page) {
    this.#page = page;
  }
  async inspectTargets() {
    const slider = await uniquePowerControl(this.#page);
    const original = await readPosition(slider);
    if (this.#labels !== void 0) {
      const active = this.#labels[original.now - original.min];
      if (active === void 0 || await readAnnouncement(slider) !== active) {
        throw new BrowserPowerTargetError(
          "power_unverified",
          "Power slider changed since its options were inspected."
        );
      }
      return snapshot(this.#labels, original);
    }
    const labels = /* @__PURE__ */ new Map();
    try {
      labels.set(original.now, await readAnnouncement(slider));
      let position = original;
      while (position.now > position.min) {
        position = await pressAndVerify(slider, "ArrowLeft", position);
        labels.set(position.now, await readAnnouncement(slider));
      }
      position = await moveTo(slider, original.now, original);
      while (position.now < position.max) {
        position = await pressAndVerify(slider, "ArrowRight", position);
        labels.set(position.now, await readAnnouncement(slider));
      }
      const ordered = positions(original).map((index) => labels.get(index));
      if (ordered.some((label) => label === void 0)) {
        throw new BrowserPowerTargetError(
          "power_invalid",
          "Power slider did not announce every visible position."
        );
      }
      const exactLabels = ordered;
      if (new Set(exactLabels).size !== exactLabels.length) {
        throw new BrowserPowerTargetError(
          "power_ambiguous",
          "Power slider announced duplicate option labels."
        );
      }
      this.#labels = exactLabels;
      return snapshot(exactLabels, original);
    } finally {
      await restore(slider, original);
    }
  }
  async selectTarget(axis, label) {
    if (axis !== POWER_AXIS) {
      throw new BrowserPowerTargetError(
        "power_target_unavailable",
        `Visible target axis ${JSON.stringify(axis)} is unavailable.`
      );
    }
    if (this.#labels === void 0) await this.inspectTargets();
    const labels = this.#labels;
    const matches = labels.filter((option) => option === label);
    if (matches.length === 0) {
      throw new BrowserPowerTargetError(
        "power_target_unavailable",
        `Power target ${JSON.stringify(label)} is unavailable.`
      );
    }
    if (matches.length !== 1) {
      throw new BrowserPowerTargetError(
        "power_ambiguous",
        `Power target ${JSON.stringify(label)} is ambiguous.`
      );
    }
    const targetIndex = labels.findIndex((option) => option === label);
    const slider = await uniquePowerControl(this.#page);
    const original = await readPosition(slider);
    const target = original.min + targetIndex;
    let verified = false;
    try {
      const moved = await moveTo(slider, target, original);
      const announced = await readAnnouncement(slider);
      verified = moved.now === target && announced === label;
      if (!verified) {
        throw new BrowserPowerTargetError(
          "power_unverified",
          `Power target ${JSON.stringify(label)} was not verified exactly.`
        );
      }
    } finally {
      if (!verified) {
        await restore(slider, original);
      }
    }
  }
};
function snapshot(labels, position) {
  const selectedIndex = position.now - position.min;
  const active = labels[selectedIndex];
  if (active === void 0) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider active position has no announced label."
    );
  }
  return {
    active: { [POWER_AXIS]: active },
    options: {
      [POWER_AXIS]: labels.map((label, index) => ({
        label,
        selected: index === selectedIndex
      }))
    }
  };
}
async function uniquePowerControl(page) {
  const slider = page.locator?.(POWER_CONTROL_SELECTOR)?.filter?.({ visible: true }) ?? page.locator?.(POWER_CONTROL_SELECTOR);
  if (slider?.count === void 0 || slider.evaluate === void 0 || slider.press === void 0) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Visible Chat Power slider is unavailable."
    );
  }
  const count = await slider.count();
  if (count !== 1) {
    throw new BrowserPowerTargetError(
      count > 1 ? "power_ambiguous" : "power_unavailable",
      count > 1 ? "Visible Chat Power slider is ambiguous." : "Visible Chat Power slider is unavailable."
    );
  }
  if (slider.isVisible !== void 0 && !await slider.isVisible()) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Visible Chat Power slider is hidden."
    );
  }
  return slider;
}
async function readPosition(slider) {
  if (slider.evaluate === void 0) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider state cannot be read."
    );
  }
  const raw = await slider.evaluate((element) => {
    const input = element.querySelector("[role='slider']");
    return {
      min: input?.getAttribute("aria-valuemin") ?? null,
      max: input?.getAttribute("aria-valuemax") ?? null,
      now: input?.getAttribute("aria-valuenow") ?? null
    };
  });
  const min = integerAttribute(raw.min);
  const max = integerAttribute(raw.max);
  const now = integerAttribute(raw.now);
  if (min === void 0 || max === void 0 || now === void 0 || max < min || max - min + 1 > MAX_POWER_POSITIONS || now < min || now > max) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider does not expose a valid bounded ARIA range."
    );
  }
  return { min, max, now };
}
async function readAnnouncement(slider) {
  if (slider.evaluate === void 0) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider announcement cannot be read."
    );
  }
  const descriptions = await slider.evaluate((element) => {
    const ids = (element.getAttribute("aria-describedby") ?? "").trim().split(/\s+/).filter(Boolean);
    return ids.flatMap((id) => {
      const node = element.ownerDocument.getElementById(id);
      if (node === null) return [];
      const ariaLive = node.getAttribute("aria-live");
      const role = node.getAttribute("role");
      return [{
        text: (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim(),
        announcement: ariaLive !== null && ariaLive !== "off" || role === "status" || role === "alert"
      }];
    });
  });
  const announcements = descriptions.filter((description) => description.announcement);
  const positionAnnouncements = descriptions.filter(
    (description) => POSITION_SUFFIX.test(description.text)
  );
  const candidates = announcements.length > 0 ? announcements : positionAnnouncements.length > 0 ? positionAnnouncements : descriptions.length === 1 ? descriptions : [];
  if (candidates.length !== 1) {
    throw new BrowserPowerTargetError(
      candidates.length > 1 ? "power_ambiguous" : "power_invalid",
      candidates.length > 1 ? "Power slider has multiple ARIA announcements." : "Power slider lacks a unique ARIA announcement."
    );
  }
  const label = (candidates[0]?.text ?? "").replace(POSITION_SUFFIX, "").trim();
  if (label.length === 0) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider ARIA announcement is empty."
    );
  }
  return label;
}
async function pressAndVerify(slider, key, before) {
  if (slider.press === void 0) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider cannot be controlled with Arrow keys."
    );
  }
  await slider.press(key);
  const after = await readPosition(slider);
  const expected = before.now + (key === "ArrowRight" ? 1 : -1);
  if (after.min !== before.min || after.max !== before.max || after.now !== expected) {
    throw new BrowserPowerTargetError(
      "power_unverified",
      `Power slider did not verify ${key} movement.`
    );
  }
  return after;
}
async function moveTo(slider, target, expectedRange) {
  let position = await readPosition(slider);
  if (position.min !== expectedRange.min || position.max !== expectedRange.max || target < position.min || target > position.max) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider range changed during control."
    );
  }
  for (let step = 0; position.now !== target && step < position.max - position.min; step += 1) {
    position = await pressAndVerify(
      slider,
      target > position.now ? "ArrowRight" : "ArrowLeft",
      position
    );
  }
  if (position.now !== target) {
    throw new BrowserPowerTargetError(
      "power_unverified",
      "Power slider did not reach the requested position."
    );
  }
  return position;
}
async function restore(slider, original) {
  try {
    const restored = await moveTo(slider, original.now, original);
    if (restored.now !== original.now) {
      throw new Error("position mismatch");
    }
  } catch {
    throw new BrowserPowerTargetError(
      "power_restore_failed",
      "Power slider original setting could not be restored."
    );
  }
}
function positions(range) {
  return Array.from(
    { length: range.max - range.min + 1 },
    (_, index) => range.min + index
  );
}
function integerAttribute(value) {
  if (value === null || !/^-?\d+$/.test(value)) return void 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}

// src/bridge/browser-port.ts
var COMPOSER_SELECTOR = "#prompt-textarea";
var SEND_SELECTOR = "button[data-testid='send-button']";
var POWER_CONTROL_SELECTOR2 = "[role='menuitem'][aria-label='Power']";
var POWER_OPENER_SELECTOR = "form:has(#prompt-textarea) button.__composer-pill[aria-haspopup='menu']";
var NEW_PAGE_READY_TIMEOUT_MS = 1e4;
var ChatGPTBrowserPort = class {
  #env;
  #acknowledgementTimeoutMs;
  #attachmentTimeoutMs;
  #artifactTimeoutMs;
  #pollMs;
  #acquired = false;
  #owner;
  #boundUrl;
  #boundConversationId;
  #boundTabId;
  #artifactSources = /* @__PURE__ */ new Map();
  #powerTargets;
  #selectedTools = /* @__PURE__ */ new Set();
  #attachedFileNames = [];
  #newChatPreflightTabId;
  constructor(env, options = {}) {
    this.#env = env;
    this.#acknowledgementTimeoutMs = positive3(options.acknowledgementTimeoutMs, 5e3);
    this.#attachmentTimeoutMs = positive3(options.attachmentTimeoutMs, 3e4);
    this.#artifactTimeoutMs = positive3(options.artifactTimeoutMs, 12e4);
    this.#pollMs = positive3(options.pollMs, 100);
  }
  async preflightFiles(paths) {
    await validateLocalFiles(paths);
  }
  async bindThread(thread) {
    const preflightTabId = thread === "new" ? this.#newChatPreflightTabId : void 0;
    const preflightPowerTargets = preflightTabId === void 0 ? void 0 : this.#powerTargets;
    this.#newChatPreflightTabId = void 0;
    this.#resetBinding();
    let acquired = preflightTabId === void 0 ? void 0 : await this.#reclaimNewChatPreflight(preflightTabId);
    if (acquired !== void 0 && preflightPowerTargets !== void 0) {
      this.#powerTargets = preflightPowerTargets;
    }
    if (preflightTabId !== void 0 && acquired === void 0 && this.#env.browser === void 0) {
      throw new Error("The inspected ChatGPT tab is no longer a zero-turn home page and no fresh tab can be created.");
    }
    acquired ??= await acquireChatGPTPage(this.#env, {
      createIfMissing: true,
      fresh: thread === "new"
    });
    this.#acquired = true;
    const page = acquired.page;
    if (thread === "new") {
      const current = await exactChatLocation(page);
      if (current.url !== CHATGPT_HOME) {
        await navigate(page, CHATGPT_HOME);
      }
      const after = await exactChatLocation(page);
      if (after.url !== CHATGPT_HOME) {
        throw new Error(`New Chat binding was not verified at ${CHATGPT_HOME}.`);
      }
      const readiness = await waitForNewChatPage(
        page,
        NEW_PAGE_READY_TIMEOUT_MS,
        this.#pollMs
      );
      if (!readiness.ready) {
        throw new Error(`New Chat binding is not ready: ${readiness.reason}`);
      }
    } else if (thread !== "current") {
      const target = exactThreadTarget(thread);
      const current = await exactChatLocation(page);
      if (current.conversationId !== target.conversationId) {
        await navigate(page, target.url);
      }
      const after = await exactChatLocation(page);
      if (after.conversationId !== target.conversationId) {
        throw new Error(
          `ChatGPT did not bind conversation ${JSON.stringify(target.conversationId)}.`
        );
      }
    }
    const binding = await this.#binding(page, thread !== "new");
    this.#boundUrl = binding.threadUrl;
    this.#boundConversationId = binding.conversationId;
    this.#boundTabId = binding.tabId;
    return binding;
  }
  async bindHandle(handle) {
    validateHandle(handle);
    this.#newChatPreflightTabId = void 0;
    this.#owner = void 0;
    this.#powerTargets = void 0;
    this.#artifactSources.clear();
    this.#selectedTools.clear();
    const target = handleTarget(handle);
    let acquired;
    try {
      acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: false,
        ...handle.tabId === void 0 ? {} : { expectedTabId: handle.tabId }
      });
    } catch (error) {
      if (!(error instanceof BrowserRuntimeError) || error.code !== "tab_id_unavailable" || target === "current") {
        throw error;
      }
      acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: true,
        fresh: true
      });
    }
    this.#acquired = true;
    const page = acquired.page;
    let navigated = false;
    if (target !== "current") {
      const exact = exactThreadTarget(target);
      const current = await exactChatLocation(page);
      if (current.conversationId !== exact.conversationId) {
        await navigate(page, exact.url);
        navigated = true;
      }
    }
    const location = await exactChatLocation(page);
    const binding = {
      tabId: exactTabId(page),
      threadUrl: location.url,
      userTurnCount: handle.userTurnBefore,
      assistantTurnCount: handle.assistantTurnBefore,
      ...location.conversationId === void 0 ? {} : { conversationId: location.conversationId }
    };
    if (binding.conversationId === void 0) {
      throw new Error("A submitted bridge handle requires an exact ChatGPT conversation.");
    }
    if (handle.conversationId !== void 0 && binding.conversationId !== handle.conversationId) {
      throw new Error("Bridge handle conversation does not match the visible thread.");
    }
    if (navigated) {
      await waitForHandleUserTurn(page, handle, NEW_PAGE_READY_TIMEOUT_MS, this.#pollMs);
    }
    this.#boundConversationId = binding.conversationId;
    this.#boundUrl = binding.threadUrl;
    this.#boundTabId = binding.tabId;
    this.#owner = { handle: { ...handle } };
    return binding;
  }
  async inspectTargets() {
    const preflight = this.#boundTabId === void 0 && this.#owner === void 0;
    const page = preflight ? await this.#newChatPreflightPage() : await this.#page();
    try {
      await openPowerMenu(page);
      this.#powerTargets ??= new ChatGPTPowerTargetPort(page);
      return await this.#powerTargets.inspectTargets();
    } finally {
      try {
        await closePowerMenu(page);
      } finally {
        if (preflight) {
          const readiness = await waitForNewChatPage(
            page,
            NEW_PAGE_READY_TIMEOUT_MS,
            this.#pollMs
          );
          this.#newChatPreflightTabId = readiness.ready ? exactTabId(page) : void 0;
        }
      }
    }
  }
  async selectTarget(axis, label) {
    const page = await this.#page();
    await openPowerMenu(page);
    try {
      this.#powerTargets ??= new ChatGPTPowerTargetPort(page);
      await this.#powerTargets.selectTarget(axis, label);
    } finally {
      await closePowerMenu(page);
    }
    if (await readComposerPowerLabel(page) !== label) {
      throw new Error(`Chat target ${JSON.stringify(label)} lacks an exact composer echo.`);
    }
    await this.#assertBoundLocation();
  }
  async selectTool(label) {
    const page = await this.#page();
    if (this.#selectedTools.has(label)) {
      await verifyVisibleTools(page, [...this.#selectedTools]);
      return;
    }
    await selectTool(page, label);
    this.#selectedTools.add(label);
    if (this.#selectedTools.size > 1) {
      await verifyVisibleTools(page, [...this.#selectedTools]);
    }
    await this.#assertBoundLocation();
  }
  async attachFiles(paths) {
    const page = await this.#page();
    const files = await attachFiles(page, paths, {
      timeoutMs: this.#attachmentTimeoutMs,
      pollMs: this.#pollMs
    });
    this.#attachedFileNames.push(...files.map((file) => file.name));
    await this.#assertBoundLocation();
  }
  async composePrompt(prompt) {
    requirePrompt(prompt);
    const page = await this.#page();
    const form = await uniqueVisible2(page, COMPOSER_FORM_SELECTOR, "ChatGPT composer form");
    if (form.evaluate === void 0) {
      throw new Error("ChatGPT composer attachment state cannot be read.");
    }
    const staged = await form.evaluate((element) => ({
      attachmentNames: Array.from(element.querySelectorAll(".truncate.font-semibold")).map((name) => (name.textContent ?? "").trim()).filter(Boolean),
      toolLabels: Array.from(element.querySelectorAll(
        "[data-inline-selection-pill][data-keyword]"
      )).map((pill) => pill.getAttribute("data-keyword") ?? "").filter(Boolean)
    }));
    const stagedAttachmentNames = staged.attachmentNames;
    if (stagedAttachmentNames.length !== this.#attachedFileNames.length || stagedAttachmentNames.some((name, index) => name !== this.#attachedFileNames[index])) {
      throw new Error("ChatGPT composer contains an unrequested staged attachment.");
    }
    const stagedToolLabels = [...new Set(staged.toolLabels)].sort();
    const selectedToolLabels = [...this.#selectedTools].sort();
    if (stagedToolLabels.length !== selectedToolLabels.length || stagedToolLabels.some((label, index) => label !== selectedToolLabels[index])) {
      throw new Error("ChatGPT composer contains an unrequested active tool.");
    }
    const composer = await uniqueVisible2(page, COMPOSER_SELECTOR, "ChatGPT composer");
    if (composer.fill === void 0 || composer.evaluate === void 0) {
      throw new Error("ChatGPT composer lacks exact fill and readback operations.");
    }
    if (await readEditableText(composer) !== prompt) await composer.fill(prompt);
    if (await readEditableText(composer) !== prompt) {
      throw new Error("ChatGPT composer readback did not exactly match the prompt.");
    }
    if (this.#selectedTools.size > 0) {
      await verifyVisibleTools(page, [...this.#selectedTools]);
    }
    await this.#assertBoundLocation();
  }
  async submissionPresentationSha256s(prompt) {
    requirePrompt(prompt);
    return promptPresentationSha256s(prompt);
  }
  async submitPrompt(input) {
    requirePrompt(input.prompt);
    if (sha2562(input.prompt) !== input.promptSha256) {
      throw new Error("Submission prompt hash does not match the exact prompt.");
    }
    if (!isCount(input.userTurnBefore)) {
      throw new Error("Submission requires a user-turn baseline.");
    }
    if (!isCount(input.assistantTurnBefore)) {
      throw new Error("Submission requires an assistant-turn baseline.");
    }
    const page = await this.#page();
    await this.#assertBoundLocation();
    try {
      await activateSend(page);
    } catch {
    }
    const deadline = Date.now() + this.#acknowledgementTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot2 = await readVisibleChatSnapshot(structural(page), {
        userIndex: input.userTurnBefore
      }).catch(() => void 0);
      if (snapshot2 !== void 0) {
        if (snapshot2.userCount > input.userTurnBefore + 1) {
          return this.#submissionReceipt(page, false);
        }
        if (snapshot2.userCount === input.userTurnBefore + 1) {
          const location = await exactChatLocation(page).catch(() => void 0);
          const conversationMatches = location?.conversationId !== void 0 && (this.#boundConversationId === void 0 || location.conversationId === this.#boundConversationId);
          const rendered = snapshot2.userText;
          if (conversationMatches && rendered !== void 0 && renderedPromptMatches(input.prompt, rendered)) {
            return this.#submissionReceipt(
              page,
              true,
              sha2562(rendered),
              snapshot2.userTurnId ?? void 0
            );
          }
        }
      }
      await pause2(page, this.#pollMs);
    }
    return this.#submissionReceipt(page, false);
  }
  async observe(handle) {
    if (this.#owner?.handle.operationId !== handle.operationId) {
      throw new Error("Observation requires the exact bound bridge handle.");
    }
    const owned = await this.#ownedSnapshot(handle);
    if (!owned.promptOwned) {
      return {
        phase: "uncertain",
        responseOwned: false,
        uncertainty: owned.reason ?? "Submitted prompt ownership could not be verified."
      };
    }
    if (!owned.assistantOwned && owned.assistantDelta > 0) {
      return {
        phase: "uncertain",
        responseOwned: false,
        uncertainty: owned.reason ?? "Owned assistant turn identity could not be verified."
      };
    }
    const identities = {
      ...owned.snapshot.userTurnId === null || owned.snapshot.userTurnId === void 0 ? {} : { userTurnId: owned.snapshot.userTurnId },
      ...!owned.assistantOwned || owned.snapshot.assistantTurnId === null || owned.snapshot.assistantTurnId === void 0 ? {} : { assistantTurnId: owned.snapshot.assistantTurnId }
    };
    if (owned.snapshot.generation.state === "generating") {
      return { phase: "generating", responseOwned: owned.assistantOwned, ...identities };
    }
    if (owned.assistantDelta === 0) {
      return { phase: "submitted", responseOwned: false, ...identities };
    }
    return owned.snapshot.generation.state === "completed" ? { phase: "completed", responseOwned: true, ...identities } : {
      phase: "generating",
      responseOwned: true,
      ...identities,
      uncertainty: "Owned response exists but completion controls are not visible yet."
    };
  }
  async copyResponseMarkdown() {
    const owned = await this.#ownedResponse();
    const target = copyTarget(owned.handle, owned.snapshot);
    const copied = await copyAssistantMarkdown(
      structural(owned.page),
      this.#clipboard(owned.page),
      target
    );
    return copied.status === "copied" ? copied.markdown : void 0;
  }
  async readResponseSnapshot() {
    const owned = await this.#ownedResponse({ includeAssistantText: true });
    const text = readOwnedAssistantText(owned.snapshot, copyTarget(owned.handle, owned.snapshot));
    if (text === void 0) throw new Error("Owned assistant response text is unavailable.");
    return {
      text,
      partial: owned.snapshot.generation.state !== "completed"
    };
  }
  async listArtifacts() {
    if (this.#owner === void 0) return [];
    const owned = await this.#ownedResponse({ includeArtifacts: true });
    const artifacts = inventoryHandleArtifacts(owned.snapshot, {
      operationId: owned.handle.operationId,
      ...owned.handle.conversationId === void 0 ? {} : { conversationId: owned.handle.conversationId },
      assistantTurnBefore: owned.handle.assistantTurnBefore
    });
    this.#artifactSources.clear();
    for (const artifact of artifacts) this.#artifactSources.set(artifact.key, artifact);
    return artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      ...artifact.name === void 0 ? {} : { name: artifact.name }
    }));
  }
  async downloadArtifact(artifact, downloadDir) {
    const owned = await this.#ownedResponse();
    const source = this.#artifactSources.get(artifact.key);
    if (source === void 0 || source.kind !== artifact.kind) {
      throw new Error("Artifact is not part of the latest handle-owned inventory.");
    }
    const downloaded = await downloadHandleArtifact(
      structural(owned.page),
      source,
      downloadDir,
      this.#artifactTimeoutMs
    );
    await this.#assertBoundLocation();
    return {
      kind: source.kind,
      name: downloaded.name,
      path: downloaded.path,
      bytes: downloaded.bytes,
      ...downloaded.sha256 === void 0 ? {} : { sha256: downloaded.sha256 }
    };
  }
  async #page() {
    if (!this.#acquired || this.#env.page === void 0) {
      const acquired = await acquireChatGPTPage(this.#env, { createIfMissing: true });
      this.#acquired = true;
      return acquired.page;
    }
    await exactChatLocation(this.#env.page);
    return this.#env.page;
  }
  async #freshNewChatPreflight() {
    this.#newChatPreflightTabId = void 0;
    this.#powerTargets = void 0;
    const acquired = await acquireChatGPTPage(this.#env, {
      createIfMissing: true,
      fresh: true
    });
    this.#acquired = true;
    const readiness = await waitForNewChatPage(
      acquired.page,
      NEW_PAGE_READY_TIMEOUT_MS,
      this.#pollMs
    );
    if (!readiness.ready) {
      throw new Error(`Target inspection page is not ready: ${readiness.reason}`);
    }
    this.#newChatPreflightTabId = exactTabId(acquired.page);
    return acquired.page;
  }
  async #newChatPreflightPage() {
    if (this.#newChatPreflightTabId !== void 0) {
      const reclaimed = await this.#reclaimNewChatPreflight(this.#newChatPreflightTabId);
      if (reclaimed !== void 0) return reclaimed.page;
      if (this.#env.browser === void 0) {
        throw new Error("The inspected ChatGPT tab is no longer a zero-turn home page and no fresh tab can be created.");
      }
    }
    return this.#freshNewChatPreflight();
  }
  async #reclaimNewChatPreflight(tabId) {
    try {
      const acquired = await acquireChatGPTPage(this.#env, {
        createIfMissing: false,
        expectedTabId: tabId
      });
      const readiness = await waitForNewChatPage(
        acquired.page,
        NEW_PAGE_READY_TIMEOUT_MS,
        this.#pollMs
      );
      return readiness.ready ? acquired : void 0;
    } catch {
      return void 0;
    }
  }
  async #binding(page, requireStable = false) {
    const { location, snapshot: snapshot2 } = requireStable ? await waitForStableThread(page, NEW_PAGE_READY_TIMEOUT_MS, this.#pollMs) : {
      location: await exactChatLocation(page),
      snapshot: await readVisibleChatSnapshot(structural(page))
    };
    return {
      tabId: exactTabId(page),
      threadUrl: location.url,
      userTurnCount: snapshot2.userCount,
      assistantTurnCount: snapshot2.assistantCount,
      ...snapshot2.userTurnId == null ? {} : { lastUserTurnId: snapshot2.userTurnId },
      ...snapshot2.assistantTurnId == null ? {} : { lastAssistantTurnId: snapshot2.assistantTurnId },
      ...location.conversationId === void 0 ? {} : { conversationId: location.conversationId }
    };
  }
  async #submissionReceipt(page, confirmed, renderedPromptSha256, userTurnId) {
    const location = await exactChatLocation(page).catch(() => void 0);
    const tabId = exactTabId(page);
    if (confirmed && location?.conversationId !== void 0) {
      this.#boundConversationId = location.conversationId;
      this.#boundUrl = location.url;
      this.#boundTabId = tabId;
    }
    return {
      confirmed,
      tabId,
      ...location === void 0 ? {} : { threadUrl: location.url },
      ...location?.conversationId === void 0 ? {} : { conversationId: location.conversationId },
      ...renderedPromptSha256 === void 0 ? {} : { renderedPromptSha256 },
      ...userTurnId === void 0 ? {} : { userTurnId }
    };
  }
  async #assertBoundLocation(boundPage) {
    const page = boundPage ?? await this.#page();
    const location = await exactChatLocation(page);
    if (this.#boundConversationId !== void 0 && location.conversationId !== this.#boundConversationId) {
      throw new Error("Controlled ChatGPT page left the handle-bound conversation.");
    }
    if (this.#boundTabId !== void 0 && exactTabId(page) !== this.#boundTabId) {
      throw new Error("Controlled ChatGPT page left the handle-bound tab.");
    }
  }
  async #ownedSnapshot(handle, options = {}) {
    const page = await this.#page();
    await this.#assertBoundLocation(page);
    const snapshot2 = await readVisibleChatSnapshot(structural(page), {
      userIndex: handle.userTurnBefore,
      assistantIndex: handle.assistantTurnBefore,
      ...options
    });
    const expectedUsers = handle.userTurnBefore + 1;
    const assistantDelta = snapshot2.assistantCount - handle.assistantTurnBefore;
    if (snapshot2.userCount < expectedUsers) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot: snapshot2,
        reason: "Visible user-turn count moved behind this handle's baseline."
      };
    }
    const rendered = snapshot2.userText;
    const exactUserIdentity = handle.userTurnId !== void 0;
    if (exactUserIdentity && snapshot2.userTurnId !== handle.userTurnId || !exactUserIdentity && !renderedPromptOwned(
      handle,
      rendered
    )) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot: snapshot2,
        reason: exactUserIdentity ? "Visible submitted user-turn identity does not match this handle." : "Visible submitted prompt hash does not match this handle."
      };
    }
    if (!exactUserIdentity && snapshot2.userCount > expectedUsers && snapshot2.userTurnId == null) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot: snapshot2,
        reason: "Later user turns exist and the owned user turn lacks a stable identity."
      };
    }
    if (assistantDelta < 0) {
      return {
        promptOwned: false,
        assistantOwned: false,
        page,
        assistantDelta,
        snapshot: snapshot2,
        reason: "Visible assistant-turn count moved behind this handle's baseline."
      };
    }
    const assistantOwned = assistantDelta > 0 && (handle.assistantTurnId === void 0 ? snapshot2.assistantTurnId != null || assistantDelta === 1 : snapshot2.assistantTurnId === handle.assistantTurnId);
    if (!assistantOwned && assistantDelta > 0) {
      return {
        page,
        promptOwned: true,
        assistantOwned: false,
        assistantDelta,
        snapshot: snapshot2,
        reason: handle.assistantTurnId === void 0 ? "Later assistant turns exist and the owned assistant turn lacks a stable identity." : "Visible assistant-turn identity does not match this handle."
      };
    }
    return { page, promptOwned: true, assistantOwned, assistantDelta, snapshot: snapshot2 };
  }
  async #ownedResponse(options = {}) {
    const owner = this.#owner;
    if (owner === void 0) {
      throw new Error("Response access requires an exact bound bridge handle.");
    }
    const owned = await this.#ownedSnapshot(owner.handle, options);
    if (!owned.promptOwned || !owned.assistantOwned) {
      throw new Error(owned.reason ?? "No uniquely owned assistant response is available.");
    }
    return { page: owned.page, handle: owner.handle, snapshot: owned.snapshot };
  }
  #clipboard(page) {
    const configured = this.#env.clipboard;
    if (configured !== void 0) {
      return {
        readText: () => configured.read(),
        waitForChange: (before, timeoutMs) => configured.waitForChange(before, timeoutMs),
        ...configured.snapshot === void 0 ? {} : { snapshot: () => configured.snapshot() },
        ...configured.restore === void 0 ? {} : { restore: (snapshot2) => configured.restore(snapshot2) },
        ...configured.writeText === void 0 ? {} : { writeText: (text) => configured.writeText(text) }
      };
    }
    const virtual = page.clipboard;
    if (virtual !== void 0 && (virtual.readText !== void 0 || virtual.read !== void 0)) {
      return {
        readText: () => readBrowserClipboardText(virtual),
        waitForChange: (before, timeoutMs) => waitForBrowserClipboardChange(page, virtual, before, timeoutMs),
        ...virtual.read === void 0 || virtual.write === void 0 ? {} : {
          snapshot: () => Promise.resolve(virtual.read()),
          restore: (snapshot2) => Promise.resolve(virtual.write(snapshot2))
        },
        ...virtual.writeText === void 0 ? {} : { writeText: (text) => Promise.resolve(virtual.writeText(text)) }
      };
    }
    return {
      readText: async () => void 0
    };
  }
  #resetBinding() {
    this.#owner = void 0;
    this.#powerTargets = void 0;
    this.#artifactSources.clear();
    this.#selectedTools.clear();
    this.#attachedFileNames = [];
    this.#boundUrl = void 0;
    this.#boundConversationId = void 0;
    this.#boundTabId = void 0;
  }
};
function createBrowserBridgePort(env, options = {}) {
  return new ChatGPTBrowserPort(env, options);
}
function structural(page) {
  if (page.evaluate === void 0) {
    throw new Error("Visible ChatGPT ownership requires page.evaluate().");
  }
  return page;
}
function copyTarget(handle, snapshot2) {
  const assistantIndex = handle.assistantTurnBefore;
  const turnId = handle.assistantTurnId ?? snapshot2.assistantTurnId;
  return {
    assistantIndex,
    ...turnId === null || turnId === void 0 ? {} : { assistantTurnId: turnId }
  };
}
function positive3(value, fallback) {
  return value !== void 0 && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function requirePrompt(prompt) {
  if (prompt.trim().length === 0) throw new Error("Prompt must be nonempty.");
}
function renderedPromptMatches(composed, rendered) {
  const allowed = new Set(promptPresentationSha256s(composed));
  return renderedPresentationSha256s(rendered).some((hash) => allowed.has(hash));
}
function promptPresentationSha256s(composed) {
  const hashes = /* @__PURE__ */ new Set([presentationHash("exact", comparablePrompt(composed))]);
  const prompt = flattenedPrompt(composed);
  if (hasVisibleLineBreak(composed)) hashes.add(presentationHash("flat", prompt));
  hashes.add(presentationHash("show-more", prompt));
  return [...hashes];
}
function renderedPresentationSha256s(rendered) {
  const hashes = [
    presentationHash("exact", comparablePrompt(rendered)),
    presentationHash("flat", flattenedPrompt(rendered))
  ];
  const showMoreContent = promptOnlyShowMoreContent(rendered);
  if (showMoreContent !== void 0) {
    hashes.push(presentationHash("show-more", flattenedPrompt(showMoreContent)));
  }
  return hashes;
}
function renderedPromptOwned(handle, rendered) {
  if (rendered === void 0) return false;
  if (handle.renderedPromptSha256 !== void 0) {
    return sha2562(rendered) === handle.renderedPromptSha256;
  }
  if (handle.promptPresentationSha256s !== void 0) {
    const expected = new Set(handle.promptPresentationSha256s);
    return renderedPresentationSha256s(rendered).some((hash) => expected.has(hash));
  }
  return sha2562(rendered) === handle.promptSha256;
}
function comparablePrompt(value) {
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ").trimEnd();
}
function flattenedPrompt(value) {
  return comparablePrompt(value).trim().replace(/\s+/g, " ");
}
function promptOnlyShowMoreContent(rendered) {
  const match = /^(.*\S)(?: *\n)+ *Show more$/s.exec(comparablePrompt(rendered));
  return match?.[1]?.trimEnd();
}
function hasVisibleLineBreak(value) {
  return /[\r\n\u2028\u2029]/.test(value);
}
function presentationHash(kind, value) {
  return sha2562(`${kind}\0${value}`);
}
function isCount(value) {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}
function validateHandle(handle) {
  if (!isCount(handle.userTurnBefore) || !isCount(handle.assistantTurnBefore)) {
    throw new Error("Bridge handle requires user and assistant turn baselines.");
  }
  if (!/^[a-f0-9]{64}$/i.test(handle.promptSha256) || handle.attachmentCount !== void 0 && (!Number.isInteger(handle.attachmentCount) || handle.attachmentCount < 1) || handle.promptPresentationSha256s !== void 0 && (handle.promptPresentationSha256s.length < 1 || handle.promptPresentationSha256s.length > 4 || new Set(handle.promptPresentationSha256s).size !== handle.promptPresentationSha256s.length || !handle.promptPresentationSha256s.every((hash) => /^[a-f0-9]{64}$/i.test(hash))) || handle.renderedPromptSha256 !== void 0 && !/^[a-f0-9]{64}$/i.test(handle.renderedPromptSha256)) {
    throw new Error("Bridge handle prompt hash is invalid.");
  }
}
function handleTarget(handle) {
  if (handle.threadUrl !== void 0 && handle.conversationId !== void 0) {
    const parsed = exactThreadTarget({ url: handle.threadUrl });
    if (parsed.conversationId !== handle.conversationId) {
      throw new Error("Bridge handle URL and conversation refer to different threads.");
    }
  }
  if (handle.threadUrl !== void 0) {
    const parsed = exactChatGPTUrl(handle.threadUrl);
    if (conversationId(parsed) !== void 0) return { url: handle.threadUrl };
    if (parsed.pathname === "/" && parsed.search === "" && parsed.hash === "") return "current";
    throw new Error("Bridge handle URL is not ChatGPT home or an exact conversation.");
  }
  if (handle.conversationId !== void 0) return { conversationId: handle.conversationId };
  return "current";
}
function exactThreadTarget(thread) {
  if ("conversationId" in thread) {
    validateConversationId(thread.conversationId);
    return {
      url: `${CHATGPT_ORIGIN}/c/${encodeURIComponent(thread.conversationId)}`,
      conversationId: thread.conversationId
    };
  }
  const parsed = exactChatGPTUrl(thread.url);
  const id = conversationId(parsed);
  if (id === void 0 || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Exact thread URLs must use https://chatgpt.com/c/<conversationId>.");
  }
  return { url: parsed.toString(), conversationId: id };
}
function conversationId(url) {
  const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
  if (match?.[1] === void 0) return void 0;
  const id = decodeURIComponent(match[1]);
  validateConversationId(id);
  return id;
}
function validateConversationId(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Conversation ID contains unsupported characters.");
  }
}
async function waitForNewChatPage(page, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let state = await readNewPageReadiness(page);
  while (!state.ready && state.retry && Date.now() < deadline) {
    await pause2(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    state = await readNewPageReadiness(page);
  }
  return state.ready ? state : { ready: false, reason: state.reason };
}
async function waitForStableThread(page, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let previousKey;
  let stableObservations = 0;
  while (Date.now() < deadline) {
    const state = await readStableThreadState(page).catch(() => void 0);
    if (state !== void 0) {
      const key = JSON.stringify([
        state.location.url,
        state.snapshot.userCount,
        state.snapshot.assistantCount,
        state.snapshot.userTurnId ?? null,
        state.snapshot.assistantTurnId ?? null
      ]);
      if (key === previousKey) {
        stableObservations += 1;
      } else {
        previousKey = key;
        stableObservations = 1;
      }
      if (stableObservations >= 3) return state;
    } else {
      previousKey = void 0;
      stableObservations = 0;
    }
    await pause2(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error("ChatGPT thread did not expose a stable non-generating turn baseline before timeout.");
}
async function readStableThreadState(page) {
  const location = await exactChatLocation(page);
  if (!await hasVisibleMain(page)) return void 0;
  const composer = page.locator?.(COMPOSER_SELECTOR);
  if (composer?.count === void 0 || await composer.count() !== 1 || composer.isVisible !== void 0 && !await composer.isVisible()) return void 0;
  const counts = await readVisibleChatSnapshot(structural(page));
  if (counts.generation.state === "generating") return void 0;
  if (location.conversationId !== void 0 && counts.userCount === 0) return void 0;
  if (location.conversationId !== void 0 && counts.assistantCount < counts.userCount) return void 0;
  const snapshot2 = await readVisibleChatSnapshot(structural(page), {
    ...counts.userCount === 0 ? {} : { userIndex: counts.userCount - 1 },
    ...counts.assistantCount === 0 ? {} : { assistantIndex: counts.assistantCount - 1 }
  });
  return snapshot2.userCount === counts.userCount && snapshot2.assistantCount === counts.assistantCount ? { location, snapshot: snapshot2 } : void 0;
}
async function readNewPageReadiness(page) {
  try {
    const location = await exactChatLocation(page);
    if (location.url !== CHATGPT_HOME) {
      return { ready: false, retry: false, reason: "page is not exact ChatGPT home" };
    }
    if (!await hasVisibleMain(page)) {
      return { ready: false, retry: true, reason: "visible ChatGPT main is not ready" };
    }
    const snapshot2 = await readVisibleChatSnapshot(structural(page));
    if (snapshot2.userCount !== 0 || snapshot2.assistantCount !== 0) {
      return { ready: false, retry: false, reason: "visible conversation turns are present" };
    }
    const found = page.locator?.(COMPOSER_SELECTOR);
    const composer = found?.filter?.({ visible: true }) ?? found;
    if (composer?.count === void 0 || composer.evaluate === void 0) {
      return { ready: false, retry: false, reason: "composer cannot be verified" };
    }
    if (await composer.count() !== 1 || composer.isVisible !== void 0 && !await composer.isVisible()) {
      return { ready: false, retry: true, reason: "one visible composer is not ready" };
    }
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      retry: true,
      reason: error instanceof Error ? error.message : "page readiness could not be read"
    };
  }
}
async function hasVisibleMain(page) {
  const main = page.locator?.("main");
  if (main?.count === void 0) return false;
  const count = await main.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = count === 1 ? main : main.nth?.(index);
    if (candidate !== void 0 && (candidate.isVisible === void 0 || await candidate.isVisible())) return true;
  }
  return false;
}
async function exactChatLocation(page) {
  const raw = await page.url?.();
  if (typeof raw !== "string") throw new Error("Controlled page URL cannot be verified.");
  const parsed = exactChatGPTUrl(raw);
  const id = conversationId(parsed);
  if ((parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") && id === void 0) {
    throw new Error("Bridge supports only ChatGPT home and exact conversation routes.");
  }
  return { url: parsed.toString(), ...id === void 0 ? {} : { conversationId: id } };
}
async function navigate(page, url) {
  if (page.goto === void 0) throw new Error("Controlled page cannot navigate.");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 3e4 });
}
async function waitForHandleUserTurn(page, handle, timeoutMs, pollMs) {
  const expected = handle.userTurnBefore + 1;
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot2 = await readVisibleChatSnapshot(structural(page)).catch(() => void 0);
    if (snapshot2 !== void 0 && snapshot2.userCount >= expected) return;
    await pause2(page, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error("Submitted ChatGPT conversation did not hydrate its owned user turn.");
}
async function openPowerMenu(page) {
  const opener = await uniqueVisible2(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  if ((await readPowerOpenerState(opener)).expanded && await visibleCount(page.locator?.(POWER_CONTROL_SELECTOR2)) === 1) return;
  let clickError;
  try {
    await activateExactPointerControl(page, opener, "ChatGPT Power opener");
  } catch (error) {
    clickError = error;
  }
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    if ((await readPowerOpenerState(opener)).expanded && await visibleCount(page.locator?.(POWER_CONTROL_SELECTOR2)) === 1) return;
    await pause2(page, 50);
  }
  if (clickError !== void 0) throw clickError;
  throw new Error("Power menu did not become expanded with one visible control.");
}
async function closePowerMenu(page) {
  const opener = await uniqueVisible2(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  if (!(await readPowerOpenerState(opener)).expanded) return;
  let closeError;
  try {
    await activateExactPointerControl(page, opener, "ChatGPT Power opener");
  } catch (error) {
    closeError = error;
  }
  const deadline = Date.now() + 3e3;
  while (Date.now() < deadline) {
    if (!(await readPowerOpenerState(opener)).expanded) return;
    await pause2(page, 50);
  }
  if (closeError !== void 0) throw closeError;
  throw new Error("Power menu remained expanded after toggling its exact composer control.");
}
async function activateExactPointerControl(page, control, label) {
  const rawCdp = await page.capabilities?.get?.("cdp");
  const cdp = rawCdp;
  if (cdp?.send !== void 0) {
    await bringPageToFront(cdp);
    if (control.evaluate === void 0) {
      throw new Error(`${label} position cannot be read.`);
    }
    const rect = await control.evaluate((element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    });
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error(`${label} has no usable visible position.`);
    }
    const point = {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", ...point, button: "none", buttons: 0 },
      { timeoutMs: 1e4 }
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 },
      { timeoutMs: 1e4 }
    );
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 },
      { timeoutMs: 1e4 }
    );
    return;
  }
  if (control.click === void 0) throw new Error(`${label} is not clickable.`);
  await control.click();
}
async function activateSend(page) {
  const send = await uniqueVisible2(page, SEND_SELECTOR, "ChatGPT Send control");
  if (send.click === void 0) throw new Error("ChatGPT Send control is not clickable.");
  await send.click();
}
function readExactComposerPrompt(editor) {
  const tag = editor.tagName.toLowerCase();
  const readContentEditableText = (root) => {
    const blocks = Array.from(root.children);
    if (blocks.length === 0 || blocks.some((block) => block.tagName !== "P")) {
      return root.innerText || root.textContent || "";
    }
    const readNode = (node) => {
      if (node.nodeType === 3) return node.textContent || "";
      if (node.nodeType !== 1) return "";
      const element = node;
      if (element.tagName === "BR") {
        return element.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
      }
      return Array.from(element.childNodes).map(readNode).join("");
    };
    return blocks.map((block) => block.getAttribute("data-empty-paragraph") === "true" ? "" : readNode(block)).join("\n");
  };
  const inlineSelectionPills = Array.from(editor.querySelectorAll(
    "[data-inline-selection-pill][data-keyword]"
  ));
  if (inlineSelectionPills.length === 0) {
    const value = editor.value;
    return (tag === "textarea" || tag === "input") && typeof value === "string" ? value : readContentEditableText(editor);
  }
  const promptEditor = editor.cloneNode(true);
  for (const pill of Array.from(promptEditor.querySelectorAll(
    "[data-inline-selection-pill][data-keyword]"
  ))) {
    const next = pill.nextSibling;
    if (next?.nodeType === 3 && next.textContent?.startsWith(" ")) {
      next.textContent = next.textContent.slice(1);
    }
    const cursorTarget = pill.previousElementSibling;
    if (cursorTarget?.matches("[data-inline-selection-pill-cursor-target]")) {
      cursorTarget.remove();
    }
    pill.remove();
  }
  promptEditor.querySelectorAll("[data-inline-selection-pill-cursor-target]").forEach((cursor) => cursor.remove());
  return readContentEditableText(promptEditor);
}
async function bringPageToFront(cdp) {
  try {
    await cdp.send("Page.bringToFront", {}, { timeoutMs: 1e4 });
  } catch {
  }
}
async function readPowerOpenerState(opener) {
  if (opener.evaluate === void 0) {
    throw new Error("ChatGPT Power opener state cannot be read.");
  }
  const state = await opener.evaluate((element) => ({
    tagName: element.tagName,
    role: element.getAttribute("role"),
    hasPopup: element.getAttribute("aria-haspopup"),
    expanded: element.getAttribute("aria-expanded"),
    label: (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim()
  }));
  if (state.tagName !== "BUTTON" || state.role !== null && state.role !== "button" || state.hasPopup !== "menu" || state.expanded !== "true" && state.expanded !== "false" || state.label.length === 0) {
    throw new Error("ChatGPT Power opener does not expose a button state and label.");
  }
  return {
    expanded: state.expanded === "true",
    label: state.label
  };
}
async function readComposerPowerLabel(page) {
  const opener = await uniqueVisible2(page, POWER_OPENER_SELECTOR, "ChatGPT Power opener");
  return (await readPowerOpenerState(opener)).label;
}
async function uniqueVisible2(page, selector, label, timeoutMs = 1e4) {
  const found = page.locator?.(selector);
  const locator = found?.filter?.({ visible: true }) ?? found;
  if (locator?.count === void 0) throw new Error(`${label} is unavailable.`);
  const deadline = Date.now() + timeoutMs;
  do {
    if (await locator.count() === 1 && (locator.isVisible === void 0 || await locator.isVisible())) return locator;
    await pause2(page, Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${label} is not uniquely visible.`);
}
async function readEditableText(locator) {
  if (locator.evaluate === void 0) throw new Error("Editable control cannot be read.");
  return locator.evaluate(readExactComposerPrompt);
}
async function visibleCount(locator) {
  if (locator?.count === void 0) return 0;
  const filtered = locator.filter?.({ visible: true }) ?? locator;
  if (filtered.count === void 0) return 0;
  const count = await filtered.count();
  if (count === 1 && filtered.isVisible !== void 0 && !await filtered.isVisible()) return 0;
  return count;
}
async function readBrowserClipboardText(clipboard) {
  if (clipboard.readText !== void 0) {
    const value = await clipboard.readText();
    return typeof value === "string" ? value : void 0;
  }
  if (clipboard.read === void 0) return void 0;
  return clipboardText(await clipboard.read());
}
async function clipboardText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = await clipboardText(item);
      if (text !== void 0) return text;
    }
    return void 0;
  }
  if (value === null || typeof value !== "object") return void 0;
  const record = value;
  for (const key of ["text/plain", "text", "data", "value"]) {
    if (typeof record[key] === "string") return record[key];
  }
  if (typeof record.getType === "function") {
    try {
      const blob = await Reflect.apply(record.getType, value, ["text/plain"]);
      if (blob !== null && typeof blob === "object" && typeof blob.text === "function") {
        const text = await Reflect.apply(blob.text, blob, []);
        return typeof text === "string" ? text : void 0;
      }
    } catch {
      return void 0;
    }
  }
  return void 0;
}
async function waitForBrowserClipboardChange(page, clipboard, before, timeoutMs) {
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  let current = await readBrowserClipboardText(clipboard);
  while (current === before && Date.now() < deadline) {
    await pause2(page, Math.min(25, Math.max(1, deadline - Date.now())));
    current = await readBrowserClipboardText(clipboard);
  }
  return current;
}
function sha2562(value) {
  return createHash4("sha256").update(value).digest("hex");
}
async function pause2(page, ms) {
  if (page.waitForTimeout !== void 0) await page.waitForTimeout(ms);
  else await new Promise((resolve4) => setTimeout(resolve4, ms));
}

// src/bridge/factory.ts
function createChatGPTBridge(options) {
  const env = {
    browser: options.browser,
    ...options.clipboard === void 0 ? {} : { clipboard: options.clipboard }
  };
  const port = new ChatGPTBrowserPort(env, {
    ...options.acknowledgementTimeoutMs === void 0 ? {} : { acknowledgementTimeoutMs: options.acknowledgementTimeoutMs },
    ...options.attachmentTimeoutMs === void 0 ? {} : { attachmentTimeoutMs: options.attachmentTimeoutMs },
    ...options.artifactTimeoutMs === void 0 ? {} : { artifactTimeoutMs: options.artifactTimeoutMs },
    ...options.pollMs === void 0 ? {} : { pollMs: options.pollMs }
  });
  return createBridge({
    port,
    ...options.stateDir === void 0 ? {} : { stateDir: options.stateDir },
    ...options.now === void 0 ? {} : { now: options.now },
    ...options.sleep === void 0 ? {} : { sleep: options.sleep }
  });
}
export {
  ChatGPTBrowserPort,
  createBridge,
  createBrowserBridgePort,
  createChatGPTBridge
};
