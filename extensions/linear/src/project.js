// 프로젝트별 설정: git 저장소 루트의 .linear.json 에 어떤 Linear 팀/프로젝트로
// 필터할지 저장한다. muxy.files 는 활성 워크트리 루트 기준으로 동작한다.

const FILE = ".linear.json";
const GITIGNORE = ".gitignore";

// .linear.json 을 프로젝트 .gitignore 에 자동 등록한다(중복 방지).
// Linear 설정에는 API 키 참조가 들어갈 수 있어, 사용자가 실수로 커밋하지 않도록 한다.
async function ensureGitignored() {
  const muxy = window.muxy;
  let content = "";
  try {
    const f = await muxy.files.read(GITIGNORE);
    content = typeof f?.content === "string" ? f.content : "";
  } catch {
    // .gitignore 없음 → 새로 만든다.
    content = "";
  }
  // 이미 정확히 같은 항목이 있으면 아무것도 하지 않는다.
  const already = content.split(/\r?\n/).some((line) => line.trim() === FILE);
  if (already) return;
  // 끝 개행을 보장한 뒤 항목을 덧붙인다.
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const next = content + (needsNewline ? "\n" : "") + FILE + "\n";
  try {
    await muxy.files.write(GITIGNORE, next);
  } catch {
    // .gitignore 갱신 실패는 설정 저장을 되돌리지 않는다.
  }
}

// .linear.json 을 읽어 파싱한다. 없거나 깨졌으면 null.
// 반환 형태: { teamKey?, projectId?, projectName? }
export async function readProjectConfig() {
  try {
    const file = await window.muxy.files.read(FILE);
    const parsed = JSON.parse(file.content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // 파일 없음 / 권한 / 파싱 실패 → 연결 안 됨으로 취급
    return null;
  }
}

// .linear.json 저장(최초 쓰기 시 files:write 동의 팝업).
export async function writeProjectConfig(cfg) {
  await window.muxy.files.write(FILE, JSON.stringify(cfg, null, 2) + "\n");
  // 설정 파일이 생기면 .gitignore 에도 자동 등록한다.
  await ensureGitignored();
}

// 연결 해제(.linear.json 을 휴지통으로).
export async function clearProjectConfig() {
  try {
    await window.muxy.files.delete([FILE]);
  } catch {
    /* 이미 없으면 무시 */
  }
}
