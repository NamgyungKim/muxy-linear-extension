// 작업 잠금: 한 번에 하나의 이슈만 작업할 수 있도록 "진행 중인 작업" 상태를
// muxy.storage 에 보관한다. 작업 시작 시 잠기고, 작업 종료 시 풀린다.
// 저장 형태: { issueId, identifier, branch, startedAt }
//
// muxy.storage 는 익스텐션 단위(모든 프로젝트 공유) 저장소라, 단일 키를 쓰면
// 다른 프로젝트로 전환해도 잠금이 그대로 따라온다. 이를 막기 위해 현재 저장소
// (워크트리) 루트로 키를 스코프해 프로젝트별로 잠금을 분리한다.

const PREFIX = "active_work";

// 현재 저장소/워크트리 루트를 잠금 스코프로 사용한다.
// repoInfo 조회 실패(권한/저장소 아님) 시엔 접두어만 쓰는 전역 키로 폴백한다.
async function scopeKey() {
  try {
    const info = await window.muxy.git.repoInfo();
    const root = info?.root ? String(info.root) : "";
    return root ? `${PREFIX}::${root}` : PREFIX;
  } catch {
    return PREFIX;
  }
}

// 현재 진행 중인 작업. 없으면 null.
export async function getActiveWork() {
  const v = await window.muxy.storage.get(await scopeKey());
  return v && typeof v === "object" ? v : null;
}

export async function setActiveWork(work) {
  await window.muxy.storage.set(await scopeKey(), work);
}

export async function clearActiveWork() {
  await window.muxy.storage.delete(await scopeKey());
}

// 이 이슈가 현재 진행 중인 작업인지.
export function isActiveIssue(active, issue) {
  return !!active && active.issueId === issue.id;
}
