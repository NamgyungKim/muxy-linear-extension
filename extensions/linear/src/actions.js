// 상태별 액션 실행 엔진. config.actions 정의를 받아 실행한다.

import { startWork, finishWork, defaultBranch } from "./git.js";
import { renderPrompt } from "./config.js";
import { fetchTeamStates, updateIssueState } from "./linear.js";
import { getActiveWork, setActiveWork, clearActiveWork, isActiveIssue } from "./worklock.js";

// 글로벌 + 프로젝트 액션을 합친 "실효 액션".
// 프로젝트 액션은 글로벌 위에 추가되며, 같은 id면 글로벌을 덮어쓴다.
export function mergeActions(globalActions, projectActions) {
  const g = Array.isArray(globalActions) ? globalActions : [];
  const p = Array.isArray(projectActions) ? projectActions : [];
  if (!p.length) return g;
  const byId = new Map(g.map((a) => [a.id, a]));
  for (const a of p) byId.set(a.id, a);
  return [...byId.values()];
}

// 이 이슈(현재 상태)에 표시할 액션 목록.
export function applicableActions(actions, issue) {
  const stateName = issue.state?.name;
  return (actions || []).filter((a) => !a.appliesTo?.length || a.appliesTo.includes(stateName));
}

// 잠금 규칙상 이 액션이 지금 실행 가능한지. { ok, reason }.
// opts.onBranch = 현재 git 브랜치가 이 이슈의 브랜치인지(수동 시작도 "진행 중"으로 인정).
export async function actionAvailability(action, issue, opts = {}) {
  const active = await getActiveWork();
  const inProgress = isActiveIssue(active, issue) || !!opts.onBranch;
  if (action.lock === "start" && active && active.issueId !== issue.id) {
    return { ok: false, reason: `${active.identifier} 작업을 먼저 마무리하세요` };
  }
  if (action.lock === "end" && !inProgress) {
    return { ok: false, reason: "이 이슈는 진행 중이 아닙니다" };
  }
  return { ok: true, active };
}

// 액션 실행.
// opts.confirmFn(action, prompt) → boolean (confirm 이 필요한 액션에서 사용)
// opts.branch → 사용할 브랜치명(없으면 진행 중 브랜치 또는 이슈 기본값)
// 반환: { ok } | { cancelled } | { blocked, reason }
export async function runAction(action, issue, config, opts = {}) {
  const avail = await actionAvailability(action, issue, { onBranch: opts.onBranch });
  if (!avail.ok) return { blocked: true, reason: avail.reason };

  const branch = opts.branch?.trim() || avail.active?.branch || defaultBranch(issue);
  const prompt = renderPrompt(action.prompt, { ...issue, branchName: branch });

  if (action.confirm && opts.confirmFn) {
    const ok = await opts.confirmFn(action, prompt);
    if (!ok) return { cancelled: true };
  }

  let base = opts.base?.trim() || action.base?.trim() || config.default_base_branch;
  // "@current" = 지금 있는 브랜치를 베이스로.
  if (base === "@current") {
    try {
      const info = await window.muxy.git.repoInfo();
      base = info?.currentBranch || "";
    } catch {
      base = "";
    }
  }
  if (action.run === "worktree" || action.run === "branch") {
    await startWork({
      issue,
      config,
      branch,
      baseBranch: base,
      useWorktree: action.run === "worktree",
      prompt,
    });
  } else {
    // current: 현재 활성 worktree/브랜치에서 실행
    await finishWork({ config, prompt });
  }

  // 실행 후 상태 변경(상태 이름 또는 타입으로 매칭)
  if (action.toState) {
    try {
      const states = await fetchTeamStates(config.api_token, issue.team.id);
      const target =
        states.find((s) => s.name === action.toState) ||
        states.find((s) => s.type === action.toState);
      if (target) await updateIssueState(config.api_token, issue.id, target.id);
    } catch {
      /* 상태 변경 실패는 액션 실행을 되돌리지 않는다 */
    }
  }

  // 작업 잠금 갱신
  if (action.lock === "start") {
    await setActiveWork({ issueId: issue.id, identifier: issue.identifier, branch });
  } else if (action.lock === "end") {
    await clearActiveWork();
  }

  return { ok: true };
}
