// 작업 잠금: 한 번에 하나의 이슈만 작업할 수 있도록 "진행 중인 작업" 상태를
// muxy.storage 에 보관한다. 작업 시작 시 잠기고, 작업 종료 시 풀린다.
// 저장 형태: { issueId, identifier, branch, startedAt }

const KEY = "active_work";

// 현재 진행 중인 작업. 없으면 null.
export async function getActiveWork() {
  const v = await window.muxy.storage.get(KEY);
  return v && typeof v === "object" ? v : null;
}

export async function setActiveWork(work) {
  await window.muxy.storage.set(KEY, work);
}

export async function clearActiveWork() {
  await window.muxy.storage.delete(KEY);
}

// 이 이슈가 현재 진행 중인 작업인지.
export function isActiveIssue(active, issue) {
  return !!active && active.issueId === issue.id;
}
