// 에이전트 카탈로그 + 실행 명령 빌더 (KNK-97).
//
// 액션마다 "어떤 에이전트를 · 어떤 모델로 · 어떤 추론강도로" 실행할지 고를 수 있게 한다.
// 여기서는 (1) 설정 UI 에 보여줄 에이전트 후보 목록(AGENTS)과
// (2) 에이전트별로 지원하는 모델/추론강도 선택지 및 그 값을 CLI 인자로 바꾸는 방법(AGENT_CAPS),
// (3) 최종 실행 명령 문자열을 만드는 buildAgentCommand 를 제공한다.

// 자주 쓰는 에이전트 CLI 후보(설정/액션 편집 공용). 직접 입력은 UI 쪽에서 "__custom" 으로 다룬다.
export const AGENTS = [
  { v: "claude", t: "Claude Code (claude)" },
  { v: "codex", t: "OpenAI Codex (codex)" },
  { v: "gemini", t: "Gemini CLI (gemini)" },
  { v: "cursor-agent", t: "Cursor Agent (cursor-agent)" },
  { v: "aider", t: "Aider (aider)" },
  { v: "grok", t: "Grok (grok)" },
  { v: "droid", t: "Factory Droid (droid)" },
];

// 에이전트별 능력 카탈로그.
//  - models: 모델 자동완성 후보(빈 값 = 에이전트 기본값). 여기 없는 모델도 자유 입력 가능.
//  - modelArg(m): 모델 값을 CLI 인자 배열로. 지정 안 하면 표준 `--model <m>` 을 쓴다.
//  - efforts: 추론강도 선택지(빈 배열 = 이 에이전트는 추론강도 옵션 없음 → UI 에서 숨김).
//  - effortArg(e): 추론강도 값을 CLI 인자 배열로.
export const AGENT_CAPS = {
  claude: {
    models: ["opus", "sonnet", "haiku"],
    // Claude Code: `claude --model <alias|id>`
    modelArg: (m) => ["--model", m],
    // Claude Code CLI 는 추론강도 플래그가 없다.
    efforts: [],
  },
  codex: {
    models: ["gpt-5-codex", "gpt-5", "o3", "o4-mini"],
    // Codex: `codex -m <model>`
    modelArg: (m) => ["-m", m],
    // Codex: `-c model_reasoning_effort="high"`
    efforts: ["minimal", "low", "medium", "high"],
    effortArg: (e) => ["-c", `model_reasoning_effort="${e}"`],
  },
  gemini: {
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    // Gemini CLI: `gemini -m <model>`
    modelArg: (m) => ["-m", m],
    efforts: [],
  },
  "cursor-agent": {
    models: ["auto", "sonnet-4.5", "opus-4.1", "gpt-5"],
    // Cursor Agent: `cursor-agent --model <model>`
    modelArg: (m) => ["--model", m],
    efforts: [],
  },
  aider: {
    models: ["sonnet", "gpt-5", "o3"],
    // Aider: `aider --model <model>`
    modelArg: (m) => ["--model", m],
    // Aider: `--reasoning-effort <level>`
    efforts: ["low", "medium", "high"],
    effortArg: (e) => ["--reasoning-effort", e],
  },
};

// 명령 문자열의 첫 토큰(basename)으로 카탈로그를 찾는다: "/usr/bin/claude --foo" → claude.
// 없으면 null(모델/추론강도 UI 는 숨기고, 모델은 표준 --model 로만 시도).
export function capsFor(command) {
  const first = String(command || "").trim().split(/\s+/)[0] || "";
  const base = first.split("/").pop();
  return AGENT_CAPS[base] || null;
}

// 액션의 에이전트 설정을 실행 명령 문자열로 편다.
//  - baseCommand: 전역/프로젝트에서 상속받는 에이전트 명령(예 "claude").
//  - agentSettings: { command, model, effort } — command 가 있으면 그 에이전트로 실행, 없으면 상속.
// 모델/추론강도 플래그는 명령 뒤에 덧붙인다(기존 플래그가 있어도 안전하게 append).
export function buildAgentCommand(baseCommand, agentSettings) {
  const base = String(baseCommand || "").trim();
  const s = agentSettings || {};
  const command = String(s.command || "").trim() || base;
  if (!command) return command;

  const caps = capsFor(command);
  const args = [];

  const model = String(s.model || "").trim();
  if (model) args.push(...(caps?.modelArg ? caps.modelArg(model) : ["--model", model]));

  const effort = String(s.effort || "").trim();
  // 추론강도는 그 에이전트가 지원할 때만 붙인다(모르는 에이전트엔 임의 플래그를 넣지 않는다).
  if (effort && caps?.effortArg) args.push(...caps.effortArg(effort));

  return args.length ? `${command} ${args.join(" ")}` : command;
}
