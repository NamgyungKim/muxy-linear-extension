// Linear GraphQL API 클라이언트.
//
// muxy.http.fetch 는 네이티브에서 실행되어 CORS 제약이 없고, 매니페스트 권한도
// 필요 없다(호스트별 런타임 동의만 최초 1회). Personal API Key 는 Authorization
// 헤더 값으로 "그대로"(Bearer 접두어 없이) 넣는다.

const ENDPOINT = "https://api.linear.app/graphql";

// code 를 가진 에러 생성(network | auth | api | parse).
function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// GraphQL 요청을 보내고 data 를 반환한다. 오류는 throw(에러에 code 부여).
export async function gql(token, query, variables = {}) {
  if (!token) throw codedError("API Key가 설정되지 않았습니다. 설정에서 입력하세요.", "auth");

  let res;
  try {
    res = await window.muxy.http.fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    // fetch 자체 실패 = 네트워크/호스트 접근 문제
    throw codedError("네트워크 오류: Linear에 연결할 수 없습니다.", "network");
  }

  // 인증 실패(키 오류)
  if (res.status === 401 || res.status === 403) {
    throw codedError("인증 실패: API 키가 올바르지 않습니다.", "auth");
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw codedError(`응답 파싱 실패 (HTTP ${res.status})`, "api");
  }
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    if (/authenticat|unauthor|api key|invalid token|forbidden/i.test(msg)) {
      throw codedError("인증 실패: API 키가 올바르지 않습니다.", "auth");
    }
    throw codedError(msg, "api");
  }
  return json.data;
}

// 이슈 목록에 공통으로 가져오는 필드.
const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  branchName
  priority
  updatedAt
  createdAt
  state { id name type color }
  team { id key name }
  project { id name }
  projectMilestone { id name }
  assignee { id name displayName avatarUrl }
  parent { id identifier title }`;

// 활성 상태 타입 필터(완료/취소 제외).
function activeStateFilter() {
  return { type: { in: ["triage", "backlog", "unstarted", "started"] } };
}

// 나에게 assign 된 이슈 목록. teamKey/projectId 로 추가 필터.
export async function fetchMyIssues(token, { teamKey = "", projectId = "", activeOnly = true, first = 50 } = {}) {
  const filter = {};
  if (activeOnly) filter.state = activeStateFilter();
  if (teamKey) filter.team = { key: { eq: teamKey } };
  if (projectId) filter.project = { id: { eq: projectId } };

  const query = `
    query MyIssues($first: Int!, $filter: IssueFilter) {
      viewer {
        id
        name
        displayName
        assignedIssues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }`;
  const data = await gql(token, query, { first, filter });
  return {
    viewer: data.viewer,
    issues: data.viewer?.assignedIssues?.nodes ?? [],
  };
}

// 특정 Linear 프로젝트의 이슈 전체(assign 여부 무관).
export async function fetchProjectIssues(token, { projectId, activeOnly = true, first = 50 }) {
  const filter = activeOnly ? { state: activeStateFilter() } : {};
  const query = `
    query ProjectIssues($id: String!, $first: Int!, $filter: IssueFilter) {
      project(id: $id) {
        id
        name
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }`;
  const data = await gql(token, query, { id: projectId, first, filter });
  return {
    project: data.project,
    issues: data.project?.issues?.nodes ?? [],
  };
}

// 접근 가능한 팀 목록(프로젝트 연결 모달용).
export async function fetchTeams(token) {
  const data = await gql(token, `query { teams(first: 100) { nodes { id key name } } }`);
  return data.teams?.nodes ?? [];
}

// 이름이 일치하는 프로젝트를 찾는다(대소문자 무시). 없으면 null.
// 폴더명 → Linear 프로젝트 자동 매칭에 사용.
export async function fetchProjectByName(token, name) {
  if (!name) return null;
  const query = `
    query ProjectByName($name: String!) {
      projects(filter: { name: { eqIgnoreCase: $name } }, first: 1) {
        nodes { id name teams(first: 1) { nodes { id key name } } }
      }
    }`;
  const data = await gql(token, query, { name });
  return data.projects?.nodes?.[0] ?? null;
}

// 특정 팀의 프로젝트 목록.
export async function fetchTeamProjects(token, teamId) {
  const query = `
    query TeamProjects($id: String!) {
      team(id: $id) {
        id
        projects(first: 100) { nodes { id name state } }
      }
    }`;
  const data = await gql(token, query, { id: teamId });
  return data.team?.projects?.nodes ?? [];
}

// 식별자(예: "KYL-534")로 단일 이슈 조회. Linear의 issue(id)는 UUID 또는 식별자를 받는다.
export async function fetchIssueById(token, id) {
  const query = `query IssueById($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
  const data = await gql(token, query, { id });
  return data.issue || null;
}

// 이슈 상세: 본문(description) + 코멘트 목록.
export async function fetchIssueDetail(token, issueId) {
  const query = `
    query IssueDetail($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        comments(first: 100) {
          nodes {
            id
            body
            createdAt
            user { id name displayName avatarUrl }
          }
        }
      }
    }`;
  const data = await gql(token, query, { id: issueId });
  const issue = data.issue;
  const comments = (issue?.comments?.nodes ?? [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { issue, comments };
}

// 워크스페이스 전체의 워크플로우 상태(이름 기준 중복 제거, 타입순 정렬).
// 액션 편집기의 "표시할 상태 / 실행 후 상태" 목록에 사용.
export async function fetchAllStates(token) {
  const data = await gql(token, `query { workflowStates(first: 250) { nodes { id name type } } }`);
  const nodes = data.workflowStates?.nodes ?? [];
  const map = new Map();
  for (const s of nodes) if (!map.has(s.name)) map.set(s.name, { name: s.name, type: s.type });
  const order = { started: 0, unstarted: 1, triage: 2, backlog: 3, completed: 4, canceled: 5 };
  return [...map.values()].sort(
    (a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name),
  );
}

// 특정 팀의 워크플로우 상태 목록(상태 변경 드롭다운용).
export async function fetchTeamStates(token, teamId) {
  const query = `
    query TeamStates($id: String!) {
      team(id: $id) {
        id
        key
        states { nodes { id name type position color } }
      }
    }`;
  const data = await gql(token, query, { id: teamId });
  const nodes = data.team?.states?.nodes ?? [];
  // position 순으로 정렬
  return nodes.slice().sort((a, b) => a.position - b.position);
}

// 이슈 상태 변경.
export async function updateIssueState(token, issueId, stateId) {
  const query = `
    mutation SetState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`;
  const data = await gql(token, query, { id: issueId, stateId });
  return data.issueUpdate?.success === true;
}

// 이슈 본문(description) 수정. 권한이 없으면 API가 오류를 반환한다.
export async function updateIssueDescription(token, issueId, description) {
  const query = `
    mutation UpdateDesc($id: String!, $description: String!) {
      issueUpdate(id: $id, input: { description: $description }) { success }
    }`;
  const data = await gql(token, query, { id: issueId, description });
  return data.issueUpdate?.success === true;
}

// 이슈에 코멘트 작성.
export async function createComment(token, issueId, body) {
  const query = `
    mutation Comment($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) { success }
    }`;
  const data = await gql(token, query, { id: issueId, body });
  return data.commentCreate?.success === true;
}

// 팀 키로 팀 id 조회(이슈 생성 시 필요). 키가 없으면 첫 팀 반환.
export async function resolveTeam(token, teamKey) {
  if (teamKey) {
    const query = `
      query TeamByKey($key: String!) {
        teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key name } }
      }`;
    const data = await gql(token, query, { key: teamKey });
    const team = data.teams?.nodes?.[0];
    if (!team) throw new Error(`팀 키 "${teamKey}" 를 찾을 수 없습니다.`);
    return team;
  }
  const data = await gql(token, `query { teams(first: 1) { nodes { id key name } } }`);
  const team = data.teams?.nodes?.[0];
  if (!team) throw new Error("팀을 찾을 수 없습니다.");
  return team;
}

// 새 이슈 생성.
export async function createIssue(token, { teamId, title, description }) {
  const query = `
    mutation Create($teamId: String!, $title: String!, $description: String) {
      issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
        success
        issue { id identifier url }
      }
    }`;
  const data = await gql(token, query, { teamId, title, description: description || null });
  if (!data.issueCreate?.success) throw new Error("이슈 생성에 실패했습니다.");
  return data.issueCreate.issue;
}
