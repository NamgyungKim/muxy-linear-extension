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

// 활성 worktree 루트별로 터미널 탭 하나를 재사용한다.
// (root → tabID) 매핑을 storage 에 보관하고, 그 탭의 터미널 pane 이 아직 살아 있으면
// 새 탭을 열지 않고 그 pane 으로 명령을 보낸다. 없으면 그때만 새 터미널을 연다.
// 재사용 스코프는 "명령이 실제로 실행되는 시점의 활성 worktree 루트"라, worktree 를
// 새로 만들든(branch/current 라 안 만들든) 지금 명령이 돌 디렉터리에 항상 대응된다.
const TERMINAL_MAP_KEY = "terminal_tab_by_root";

async function openOrReuseTerminal(command) {
  const muxy = window.muxy;

  // 명령이 실행될 활성 worktree 루트(캐시 우회를 위해 fresh).
  let root = "";
  try {
    const info = await muxy.git.repoInfo({ fresh: true });
    root = info?.root ? String(info.root) : "";
  } catch {
    /* 저장소 정보 조회 실패 시 스코프 없이 진행(항상 새 탭) */
  }

  // 이 루트에 매핑된 기존 터미널 탭이 살아 있으면 재사용.
  let map = {};
  try {
    map = (await muxy.storage.get(TERMINAL_MAP_KEY)) || {};
  } catch {
    map = {};
  }
  const wantTab = root ? map[root] : null;
  if (wantTab) {
    try {
      const panes = await muxy.panes.list();
      const pane = panes.find((p) => p && p.kind === "terminal" && p.tabID === wantTab);
      if (pane) {
        // 기존 터미널로 포커스 후 명령 실행(개행으로 즉시 실행).
        await muxy.tabs.switchTo(pane.tabID);
        await muxy.panes.send(pane.paneID, command + "\n");
        return command;
      }
    } catch {
      /* pane 조회/전송 실패 시 아래에서 새 탭을 연다 */
    }
  }

  // 재사용할 터미널이 없으면 새로 연다.
  const tabID = await muxy.tabs.open({ kind: "terminal", command });
  if (root && tabID) {
    map[root] = tabID;
    try {
      await muxy.storage.set(TERMINAL_MAP_KEY, map);
    } catch {
      /* 매핑 저장 실패는 무시(다음에 새 탭이 열릴 뿐) */
    }
  }
  return command;
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
  const command = `${config.agent_command} "$(cat ${START_PROMPT_PATH})"`;
  // 브랜치/worktree 전환 후 실제 실행 디렉터리에 프롬프트 파일을 쓰고 터미널을 연다.
  const launch = async () => {
    await writeStartPrompt(prompt);
    return openOrReuseTerminal(command);
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
      const parent = config.worktree_root?.trim() || parentDir(repo.root);
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
      await muxy.git.worktree.switchTo({ identifier: branch });
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

// 작업 종료: 현재 활성 worktree/브랜치에서 종료 프롬프트로 에이전트를 실행한다.
// (브랜치/worktree 를 새로 만들지 않는다 — 지금 작업 중인 곳에서 마무리 절차를 돌린다.)
// opts: { config, prompt }
export async function finishWork({ config, prompt }) {
  const command = `${config.agent_command} ${shq(prompt)}`;
  await openOrReuseTerminal(command);
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
