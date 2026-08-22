// "작업 시작" 흐름의 git/터미널 로직. 이슈 상세 모달에서 사용한다.

import { renderPrompt } from "./config.js";
import { readProjectConfig, writeProjectConfig } from "./project.js";

// 쉘 단일 인용 이스케이프.
function shq(s) {
  return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

// 작업 시작 프롬프트를 담는 고정 경로.
// 터미널 자동 실행(tabs.runCommand) consent 는 명령 문자열 전체(shellExact)로만 기억되므로,
// 이슈키가 매번 바뀌는 프롬프트를 명령줄에 박으면 이슈마다 권한 창이 다시 뜬다.
// → 프롬프트는 이 파일에 쓰고, 명령은 `claude "$(cat 이파일)"` 처럼 불변으로 만들어
//   "Allow & remember" 한 번이면 이후 모든 이슈에서 다시 묻지 않게 한다.
const PROMPT_DIR = ".muxy-linear";
const START_PROMPT_PATH = `${PROMPT_DIR}/start-prompt`;

// muxy.files.write 는 부모 폴더를 자동 생성하지 않으므로 .muxy-linear 를 먼저 만든다.
// 이미 있으면 mkdir 이 실패할 수 있어 무시하고, .gitignore 에도 등록한다.
async function ensurePromptDir() {
  try { await window.muxy.files.mkdir(PROMPT_DIR); } catch { /* 이미 있으면 무시 */ }
  await ensureGitignore();
}

// 프로젝트 .gitignore 에 .muxy-linear/ 를 추가한다(작업 산출물이 아니라 커밋 대상이 아니다).
async function ensureGitignore() {
  const entry = `${PROMPT_DIR}/`;
  let content = "";
  try {
    const f = await window.muxy.files.read(".gitignore");
    content = f.content || "";
  } catch { /* .gitignore 가 없으면 새로 만든다 */ }
  const has = content.split("\n").map((l) => l.trim()).some((l) => l === entry || l === PROMPT_DIR);
  if (has) return;
  const prefix = content && !content.endsWith("\n") ? `${content}\n` : content;
  try {
    await window.muxy.files.write(".gitignore", `${prefix}${entry}\n`);
  } catch { /* 쓰기 거부 등은 무시(폴더 생성은 이미 됨) */ }
}

// 작업 시작 프롬프트를 고정 경로에 기록한다(명령이 이 파일을 cat 으로 읽는다).
async function writeStartPrompt(prompt) {
  await ensurePromptDir();
  await window.muxy.files.write(START_PROMPT_PATH, String(prompt ?? ""));
}

// 프로젝트 연결(.linear.json)을 새 worktree 로 전파한다.
// muxy.files 는 활성 worktree 루트 기준이라, worktree 를 새로 만들어 그리로 전환하면
// 그 디렉터리엔 .linear.json 이 없어 프로젝트 링크/토큰 오버라이드가 사라진 것처럼 보인다.
// (KNK-67) worktree 전환 직후, 전환 전에 읽어 둔 설정을 그 worktree 에 한 번 써 준다.
// 이미 그 worktree 에 설정이 있으면(재사용 등) 손대지 않는다.
async function ensureProjectConfigInWorktree(savedCfg) {
  if (!savedCfg) return; // 원래 연결이 없었으면 전파할 것도 없다.
  try {
    const existing = await readProjectConfig();
    if (existing) return; // 이 worktree 에 이미 설정이 있으면 덮어쓰지 않는다.
    await writeProjectConfig(savedCfg);
  } catch {
    // 전파 실패는 작업 시작을 막지 않는다(설정은 원래 위치에 그대로 있다).
  }
}

// 브랜치명을 디렉토리 슬러그로 변환.
function slug(branch) {
  return String(branch).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

// 경로의 상위 디렉토리.
function parentDir(path) {
  return path.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
}

// 새 터미널 탭을 열어 명령을 실행한다("작업 시작"처럼 에이전트를 새로 띄우는 경우).
async function openTerminal(command) {
  await window.muxy.tabs.open({ kind: "terminal", command });
  return command;
}

// 브랜치명 정규화: 이슈 매칭용. refs/heads/·origin/ 접두어와 뒤 슬래시를 떼고 NFC 로 통일.
function normBranch(s) {
  return String(s ?? "")
    .normalize("NFC")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/\/+$/, "");
}

// "이 이슈의 브랜치"에서 실행 중인 AI 에이전트 세션의 paneID 를 찾는다(없으면 null).
//
// 반드시 "같은 이슈"에서만 이어가야 하므로, 루트/cwd 가 아니라 에이전트가 속한 worktree 의
// 브랜치가 이 이슈의 브랜치와 일치할 때만 매칭한다. (branch 모드처럼 여러 이슈가 같은 루트를
// 공유해도, 브랜치는 이슈마다 다르므로 다른 이슈의 세션에 프롬프트가 새지 않는다.)
//
// muxy.agents.list() = 살아 있는 에이전트 세션 { worktreeID, paneID, status, ... }.
// muxy.worktrees.list() = worktree 별 { id, branch, ... }. 둘을 worktreeID 로 이어
// "브랜치가 일치하는 worktree 에서 도는 에이전트"만 고른다. pane 이 종료되면 agents.list
// 에서도 빠지므로, 목록에 있으면 그 세션에 실제로 이어서 입력할 수 있다.
async function findAgentPaneForBranch(branch) {
  const muxy = window.muxy;
  if (!muxy.agents?.list || !muxy.worktrees?.list) return null; // API 미지원 → 조용히 폴백.

  const target = normBranch(branch);
  if (!target) return null; // 이슈 브랜치를 모르면 매칭 불가 → 폴백.

  let agents = [];
  try { agents = await muxy.agents.list(); } catch { return null; }
  if (!Array.isArray(agents) || !agents.length) return null;

  let worktrees = [];
  try { worktrees = await muxy.worktrees.list(); } catch { return null; }
  // worktreeID → 그 worktree 에 체크아웃된 브랜치.
  const branchByWtId = new Map((worktrees || []).map((w) => [w.id, normBranch(w.branch)]));

  // 여러 개면 사람이 다음 지시를 넣기 가장 안전한 순서로: 입력 대기(waiting) > 종료된 턴(idle) > 작업중(working).
  const rank = { waiting: 3, idle: 2, working: 1 };
  let best = null;
  for (const a of agents) {
    if (!a || !a.paneID) continue;
    if (branchByWtId.get(a.worktreeID) !== target) continue; // 다른 이슈(브랜치)면 건너뜀.
    if (!best || (rank[a.status] || 0) > (rank[best.status] || 0)) best = a;
  }
  return best ? best.paneID : null;
}

// 저장소 루트의 마지막 세그먼트(폴더명).
function baseName(path) {
  return path.replace(/\/+$/, "").split("/").pop();
}

// 현재 저장소의 브랜치 후보 목록(로컬 + 원격, 중복 제거).
export async function listBaseBranchCandidates() {
  const [local, remote] = await Promise.all([
    window.muxy.git.branches().catch(() => []),
    window.muxy.git.remoteBranches().catch(() => []),
  ]);
  // origin/ 접두어는 제거해 로컬 브랜치명으로 합친다.
  const normalized = remote.map((b) => b.replace(/^origin\//, ""));
  return Array.from(new Set([...local, ...normalized]));
}

// 작업 시작: 브랜치/worktree 생성 후 터미널 탭에서 에이전트 실행.
// opts: { issue, config, branch, baseBranch, useWorktree, prompt }
// 반환: 실행한 터미널 command 문자열(로그/토스트용).
export async function startWork({ issue, config, branch, baseBranch, useWorktree, prompt }) {
  const muxy = window.muxy;
  // worktree 로 전환하기 전에 현재 활성 루트의 프로젝트 연결(.linear.json)을 읽어 둔다.
  // 전환 후 새 worktree 에 이 설정을 전파해 "설정이 사라지는" 문제를 막는다(KNK-67).
  const savedProjectCfg = await readProjectConfig();
  // 명령은 프롬프트 내용과 무관하게 항상 동일(shellExact 재사용). 실제 프롬프트는 파일로 넘긴다.
  // 프롬프트가 비었으면(선택값) 빈 인자를 넘기지 않고 에이전트만 실행한다.
  const hasPrompt = !!String(prompt ?? "").trim();
  const command = hasPrompt ? `${config.agent_command} "$(cat ${START_PROMPT_PATH})"` : config.agent_command;
  // 브랜치/worktree 전환 후 실제 실행 디렉터리에 프롬프트 파일을 쓰고 터미널을 연다.
  const launch = async () => {
    await writeStartPrompt(prompt);
    return openTerminal(command);
  };

  // 한글 브랜치명은 NFC/NFD 정규화가 달라 비교가 어긋날 수 있으므로 NFC 로 통일해 비교한다.
  const nfc = (s) => String(s ?? "").normalize("NFC");
  const branchN = nfc(branch);

  // 로컬/원격 브랜치 목록
  const [localBranches, remoteBranches] = await Promise.all([
    muxy.git.branches().catch(() => []),
    muxy.git.remoteBranches().catch(() => []),
  ]);
  const localN = localBranches.map(nfc);
  const remoteShortN = remoteBranches.map((b) => nfc(b.replace(/^origin\//, "")));
  const branchExists = localN.includes(branchN);

  // 베이스 브랜치가 실제로 없으면 현재 브랜치로 대체(없으면 그대로 시도).
  if (baseBranch && !localN.includes(nfc(baseBranch)) && !remoteShortN.includes(nfc(baseBranch))) {
    let fallback = "";
    try {
      const info = await muxy.git.repoInfo();
      fallback = info?.currentBranch || "";
    } catch { /* 무시 */ }
    console.warn(`[linear] 베이스 브랜치 '${baseBranch}' 없음 → '${fallback || "HEAD"}' 사용`);
    baseBranch = fallback || baseBranch;
  }

  if (useWorktree) {
    // 이미 이 브랜치의 worktree 가 있으면 재사용.
    let existingWt = null;
    try {
      const wts = await muxy.git.worktrees();
      existingWt = wts.find((w) => nfc(w.branch).replace(/^refs\/heads\//, "") === branchN);
    } catch { /* 목록 조회 실패는 무시하고 새로 만든다 */ }

    if (existingWt) {
      await muxy.git.worktree.switchTo({ identifier: existingWt.branch });
    } else {
      const repo = await muxy.git.repoInfo();
      const parent = parentDir(repo.root); // worktree 는 항상 저장소 루트의 형제 위치에 만든다.
      const wtPath = `${parent}/${baseName(repo.root)}-${slug(branch)}`;
      try {
        // 브랜치가 이미 있으면 새로 만들지 않고 그 브랜치로 worktree 를 붙인다.
        await muxy.git.worktree.add({ path: wtPath, branch, createBranch: !branchExists, baseBranch });
      } catch (e) {
        // "already exists"(정규화 불일치 등) 면 새 브랜치 없이 붙이기로 재시도.
        if (/already exists/i.test(e?.message || "")) {
          await muxy.git.worktree.add({ path: wtPath, branch, createBranch: false });
        } else {
          throw e;
        }
      }
      // worktree.add 직후엔 muxy 의 worktree 레지스트리가 아직 갱신 전이라, 곧바로 switchTo 하면
      // "worktree not found" 가 난다(첫 실행만 실패, 재실행은 성공). 방금 만든 worktree 를
      // 레지스트리에 반영한 뒤, 브랜치명 대신 방금 만든 경로로 전환한다(NFC/NFD 문제도 피한다).
      // refresh 는 worktrees:write 권한이 필요하다(KNK-86: 권한 누락으로 refresh 가 no-op 되어
      // 캐시가 stale 인 채 switchTo 가 실패했었다). sibling git-workspace 확장의 검증된 방식이다.
      await muxy.worktrees.refresh().catch(() => {});
      await muxy.git.worktree.switchTo({ identifier: wtPath });
    }
    // 전환된 worktree 에 프로젝트 연결을 전파한다(없을 때만).
    await ensureProjectConfigInWorktree(savedProjectCfg);
    await launch();
  } else {
    if (branchExists) {
      // 이미 있으면 그 브랜치로 전환.
      await muxy.git.branch.switchTo({ branch });
    } else {
      // 베이스로 전환 후 새 브랜치 생성(현재 worktree 에서 체크아웃).
      await muxy.git.branch.switchTo({ branch: baseBranch });
      try {
        await muxy.git.branch.create({ name: branch });
      } catch (e) {
        if (/already exists/i.test(e?.message || "")) {
          await muxy.git.branch.switchTo({ branch });
        } else {
          throw e;
        }
      }
    }
    await launch();
  }

  return command;
}

// 작업 종료: 현재 활성 worktree/브랜치에서 종료 프롬프트로 에이전트를 이어서 진행한다.
// (브랜치/worktree 를 새로 만들지 않는다 — 지금 작업 중인 곳에서 마무리 절차를 돌린다.)
//
// (KNK-72) "작업 시작"으로 띄운 에이전트가 그 탭에서 아직 돌고 있으면, 새 탭/새 세션을 열지 않고
// 그 세션 pane 에 프롬프트를 그대로 입력해 같은 대화에 "이어서" 진행한다. `claude "프롬프트"`
// 처럼 감싸지 않고 프롬프트 텍스트만 보내는 이유: 이미 실행 중인 에이전트의 입력창에 넣어
// 새 지시로 제출하기 위해서다(감싸면 그 문자열이 그대로 메시지로 들어가 버린다).
// 단, 반드시 "같은 이슈(=이 이슈의 브랜치)"에서 도는 에이전트에만 이어간다(branch 로 판별).
// 이어갈 에이전트가 없으면(세션 종료 등) 예전처럼 에이전트를 새로 실행한다.
// opts: { config, prompt, branch }  (branch = 이 이슈의 브랜치)
export async function finishWork({ config, prompt, branch }) {
  const muxy = window.muxy;
  // 프롬프트가 비었으면(선택값) 빈 인자를 넘기지 않고 에이전트만 실행한다.
  const p = String(prompt ?? "").trim();

  const paneID = await findAgentPaneForBranch(branch);
  if (paneID) {
    try {
      // 프롬프트를 입력창에 넣은 뒤, "Enter" 키로 제출한다 → 실행 중인 에이전트가 이어받는다.
      // 주의: panes.send 의 "\n"(LF, 0x0A)은 제출이 아니라 입력창 안 줄바꿈이라 실행이 안 된다.
      // 제출은 반드시 Enter 키 = CR(0x0D)이어야 하므로 sendKeys("enter")로 보낸다.
      // 프롬프트는 멀티라인일 수 있으니 본문은 send 로 한 번에(줄바꿈 유지), 마지막에 Enter 한 번.
      // (프롬프트가 비었으면 빈 줄을 제출하지 않고 포커스만 옮긴다.)
      if (p) {
        await muxy.panes.send(paneID, p);
        await muxy.panes.sendKeys(paneID, "enter");
      }
      // 사용자가 진행 상황을 볼 수 있게 그 탭(= pane 이 있는 탭)을 앞으로 가져온다.
      try { await muxy.tabs.switchTo(paneID); } catch { /* 포커스 실패는 무시 */ }
      return p || config.agent_command;
    } catch {
      /* 전송 실패(예: pane 표면 준비 안 됨) → 아래 폴백으로 새 터미널 실행 */
    }
  }

  const command = p ? `${config.agent_command} ${shq(prompt)}` : config.agent_command;
  await openTerminal(command);
  return command;
}

// 작업 시작 프롬프트 기본값 계산(브랜치명 반영).
export function defaultPrompt(config, issue, branch) {
  return renderPrompt(config.start_prompt_template, { ...issue, branchName: branch });
}

// 작업 종료 프롬프트 기본값 계산.
export function defaultFinishPrompt(config, issue, branch) {
  return renderPrompt(config.finish_prompt_template, { ...issue, branchName: branch });
}

// 이슈의 기본 브랜치명(Linear 추천값 우선, 없으면 fallback).
export function defaultBranch(issue) {
  if (issue.branchName) return issue.branchName;
  const idSlug = String(issue.identifier || "issue").toLowerCase();
  const titleSlug = slug(String(issue.title || "").toLowerCase()).slice(0, 40);
  return `feature/${idSlug}${titleSlug ? "-" + titleSlug : ""}`;
}
