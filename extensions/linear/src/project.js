// 프로젝트별 설정: git 저장소 루트의 .linear.json 에 어떤 Linear 팀/프로젝트로
// 필터할지 저장한다. muxy.files 는 활성 워크트리 루트 기준으로 동작한다.

const FILE = ".linear.json";

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
}

// 연결 해제(.linear.json 을 휴지통으로).
export async function clearProjectConfig() {
  try {
    await window.muxy.files.delete([FILE]);
  } catch {
    /* 이미 없으면 무시 */
  }
}
