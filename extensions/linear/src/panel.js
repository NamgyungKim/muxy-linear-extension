// Linear 패널: 나에게 assign 된 이슈 목록 + 현재 브랜치 이슈 강조 + 이슈 클릭 시
// 상세/작업시작 모달 오픈. 프로젝트가 .linear.json 으로 연결돼 있으면 그 Linear
// 프로젝트로 자동 필터한다.

import "./theme.css";
import "./panel.css";
import { installFatalHandler } from "./fatal.js";
import { loadConfig, saveConfig, effectiveToken, applyProjectSettings } from "./config.js";
import { fetchMyIssues, fetchProjectIssues, fetchIssueById } from "./linear.js";
import { readProjectConfig } from "./project.js";
import { applicableActions, runAction, mergeActions } from "./actions.js";
import { setLang, getLang, t } from "./i18n.js";

const muxy = window.muxy;
const content = document.getElementById("content");
const subbar = document.getElementById("subbar");
const linkedEl = document.getElementById("linked");
const spinnerEl = document.getElementById("topbar-spinner");

// 로딩 표시: 목록을 0으로 비우지 않고 상단바 동그라미만 켠다/끈다.
function setLoading(on) { if (spinnerEl) spinnerEl.hidden = !on; }

// 예상치 못한 오류를 content 영역에 드러낸다.
installFatalHandler("content");

let who = "mine"; // mine | all (연결된 프로젝트에서 내 이슈만/전체)
let currentIssueId = null; // 현재 git 브랜치에 해당하는 이슈 identifier
let projectCfg = null; // .linear.json 내용(연결 정보) 또는 null
let displayCfg = {}; // 목록 표시 옵션(config 의 list_* 값)
let allIssues = []; // 마지막으로 가져온 이슈 전체(상태 필터는 클라이언트에서 적용)
let stateFilter = ""; // 선택된 상태 이름("" = 전체)
let searchQuery = ""; // 이슈 검색어(번호/제목)
const collapsed = new Set(); // 접힌 부모 이슈 id 집합(자식 숨김)

// 자동 새로고침(폴링) 상태. 최소 1초 간격으로 신규 데이터를 가져오되, 실제로 바뀐
// 경우에만 목록 DOM 을 다시 그린다 → 리스트가 0으로 비었다가 다시 나오는 깜빡임 제거.
const POLL_MS = 3000; // 폴링 간격(3초. 시간당 ~1200회로 Linear 한도(2500) 대비 여유)
let pollTimer = null; // setInterval 핸들
let currentToken = null; // 마지막으로 사용한 실효 토큰(폴링에서 재사용)
let listReady = false; // 리스트가 실제로 표시된 상태인가(연결+키 OK)
let lastSignature = null; // 마지막으로 그린 데이터의 시그니처(변경 감지용)
let busy = false; // render/폴링 동시 실행 방지 가드
// 패널이 화면에 활성(포커스)일 때만 폴링한다. muxy.onFocus(true/false) 로 갱신하며,
// 초기값은 muxy.focused(현재 서페이스 포커스 상태)로 잡는다 → 시작 시 뒤에 가려진
// 패널은 폴링하지 않는다. onFocus/focused 가 없는 구버전이면 true 로 폴백(항상 폴링).
// 비활성 패널은 요청을 보내지 않아 Linear 요청 한도 소모를 줄인다. document.hidden 은
// muxy 다중 웹뷰에서 신뢰할 수 없어 쓰지 않는다.
let active = muxy.focused ?? true;

// 우선순위 라벨(Linear: 0 없음, 1 긴급, 2 높음, 3 보통, 4 낮음). 언어에 따라 실행 시 조회.
const priorityLabel = (p) => ({ 1: t("priority.urgent"), 2: t("priority.high"), 3: t("priority.normal"), 4: t("priority.low") }[p]);

// 정적 HTML(패널 index.html)의 텍스트를 현재 언어로 채운다.
function applyStaticI18n() {
  const search = document.getElementById("search");
  if (search) search.placeholder = t("panel.searchPlaceholder");
  const mine = document.querySelector('#who .seg-btn[data-who="mine"]');
  if (mine) mine.textContent = t("panel.myIssues");
  const all = document.querySelector('#who .seg-btn[data-who="all"]');
  if (all) all.textContent = t("panel.wholeProject");
  const sfFirst = document.querySelector("#state-filter option[value='']");
  if (sfFirst) sfFirst.textContent = t("common.all");
  // 아이콘 버튼 · 필터 tooltip
  const setTitle = (id, key) => { const n = document.getElementById(id); if (n) n.title = t(key); };
  setTitle("state-filter", "panel.stateFilterTitle");
  setTitle("display", "panel.displayTitle");
  setTitle("new", "panel.newIssueTitle");
  setTitle("refresh", "panel.refreshTitle");
  setTitle("settings", "panel.settingsTitle");
  const gl = document.getElementById("group-by-label");
  if (gl) gl.textContent = t("panel.grouping");
  const sl = document.getElementById("sort-by-label");
  if (sl) sl.textContent = t("panel.ordering");
}

// 그룹/정렬 옵션 정의(값 → i18n 라벨 키). select 채우기와 시그니처에 공용으로 쓴다.
const GROUP_OPTS = [
  { v: "status", k: "panel.groupStatus" },
  { v: "assignee", k: "panel.groupAssignee" },
  { v: "priority", k: "panel.groupPriority" },
  { v: "project", k: "panel.groupProject" },
  { v: "milestone", k: "panel.groupMilestone" },
  { v: "none", k: "panel.groupNone" },
];
const SORT_OPTS = [
  { v: "updated", k: "panel.sortUpdated" },
  { v: "created", k: "panel.sortCreated" },
  { v: "priority", k: "panel.sortPriority" },
  { v: "status", k: "panel.sortStatus" },
  { v: "title", k: "panel.sortTitle" },
];

// 두 select 를 현재 언어 라벨로 채우고 현재 값을 반영한다.
function populateDisplayMenu() {
  const fill = (id, opts, cur) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = "";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = t(o.k);
      sel.append(opt);
    }
    sel.value = cur;
  };
  fill("group-by", GROUP_OPTS, displayCfg.list_group_by || "status");
  fill("sort-by", SORT_OPTS, displayCfg.list_sort_by || "updated");
}

// 상태 그룹 정렬 순서(타입 기준).
const TYPE_ORDER = { started: 0, unstarted: 1, triage: 2, backlog: 3, completed: 4, canceled: 5 };

// 이슈 식별자 정규식(예: KYL-123)
const ID_RE = /([A-Z][A-Z0-9]+-\d+)/;

// ---- 렌더링 헬퍼 -------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (props.dataset) Object.assign(node.dataset, props.dataset);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// 이름의 이니셜(아바타용).
function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function stateBadge(state) {
  const badge = el("span", { className: "badge" });
  const dot = el("span", { className: "dot" });
  // 상태 색상을 배지 전체(테두리·배경·텍스트)에 입혀 한눈에 구분되게 한다.
  if (state?.color) {
    dot.style.color = state.color;
    badge.style.setProperty("--state-color", state.color);
    badge.classList.add("badge--state");
  }
  badge.append(dot, document.createTextNode(state?.name ?? "—"));
  return badge;
}

// 이슈 번호를 클립보드로 복사한다. 최신 clipboard API 를 우선 쓰고, 사용할 수
// 없으면 임시 textarea + execCommand 로 폴백한다.
async function copyIssueId(identifier) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(identifier);
      ok = true;
    }
  } catch { /* 폴백으로 진행 */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = identifier;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch { ok = false; }
  }
  if (ok) muxy.toast?.({ title: t("panel.copiedToast"), body: identifier });
  else muxy.toast?.({ title: t("panel.copyFailToast"), body: identifier });
}

function issueRow(issue, { indent = false, showProject = false } = {}) {
  const row = el("button", { className: "issue" });
  if (issue.identifier === currentIssueId) row.classList.add("is-current");
  if (indent) row.classList.add("is-child");

  // 부모 이슈가 있으면 상단에 브레드크럼 표시.
  if (displayCfg.list_show_parent && issue.parent) {
    row.append(el("div", { className: "issue-parent" }, `↳ ${issue.parent.identifier} ${issue.parent.title}`));
  }

  const top = el("div", { className: "issue-top" });
  // 이슈 번호는 클릭 시 행이 열리는 대신 번호를 클립보드로 복사한다.
  const idEl = el("span", {
    className: "issue-id",
    title: t("panel.copyIdTitle"),
    role: "button",
    tabIndex: 0,
  }, issue.identifier);
  const copyId = (e) => { e.stopPropagation(); copyIssueId(issue.identifier); };
  idEl.addEventListener("click", copyId);
  idEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyId(e); }
  });
  top.append(idEl);
  if (displayCfg.list_show_state) top.append(stateBadge(issue.state));
  if (displayCfg.list_show_priority && priorityLabel(issue.priority)) {
    top.append(el("span", { className: "issue-prio" }, priorityLabel(issue.priority)));
  }
  // 프로젝트가 섞여 보일 때만 프로젝트 칩 표시.
  if (showProject && displayCfg.list_show_project && issue.project?.name) {
    top.append(el("span", { className: "issue-project" }, issue.project.name));
  }
  // 마일스톤 칩.
  if (displayCfg.list_show_milestone && issue.projectMilestone?.name) {
    top.append(el("span", { className: "issue-milestone", title: t("panel.milestoneTitle") }, `◆ ${issue.projectMilestone.name}`));
  }
  // 담당자 아바타.
  if (displayCfg.list_show_assignee) {
    const name = issue.assignee?.displayName || issue.assignee?.name;
    const av = el("span", { className: "assignee", title: name ? t("panel.assigneeTitle", { name }) : t("panel.noAssignee") }, name ? initials(name) : "–");
    if (!name) av.classList.add("is-empty");
    top.append(av);
  }
  // 현재 상태에 해당하는 액션 버튼들.
  // API 키와 에이전트가 모두 설정돼 있어야 액션을 쓸 수 있으므로, 없으면 버튼 자체를 숨긴다.
  const actionsReady = !!displayCfg.api_token && !!displayCfg.agent_command;
  if (displayCfg.list_show_actions && actionsReady) {
    const acts = el("span", { className: "issue-acts" });
    for (const a of applicableActions(displayCfg.actions, issue)) {
      const b = el("button", { className: "row-btn", title: a.label }, a.icon ? `${a.icon} ${a.label}` : a.label);
      b.addEventListener("click", (e) => { e.stopPropagation(); runRowAction(a, issue); });
      acts.append(b);
    }
    if (acts.childElementCount) top.append(acts);
  }
  const title = el("div", { className: "issue-title" }, issue.title);
  row.append(top, title);
  row.addEventListener("click", () => openIssue(issue));
  return row;
}

// 행에서 액션 실행.
async function runRowAction(action, issue) {
  const config = await loadConfig();
  try {
    const res = await runAction(action, issue, config, {
      confirmFn: (a, prompt) =>
        muxy.dialog
          .confirm({
            title: a.label,
            message: `${a.label}\n\n${prompt}`,
            buttons: [t("common.run"), t("common.cancel")],
            cancel: t("common.cancel"),
          })
          .then((c) => c === t("common.run")),
    });
    if (res.cancelled) return;
    muxy.toast?.({ title: action.label, body: issue.identifier });
    render();
  } catch (e) {
    const msg = e?.message || String(e);
    console.error(`[linear] action '${action.label}' 실패:`, msg);
    muxy.toast?.({ title: t("action.failed", { label: action.label }), body: msg });
    // 토스트는 사라지므로 패널 상단에 오류를 남긴다(다음 새로고침 때까지).
    content.prepend(el("div", { className: "empty error", style: "text-align:left" }, t("panel.actionFailedInline", { label: action.label, msg })));
  }
}

// 한 그룹 안에서 부모 → 자식 순으로 정렬(자식은 들여쓰기). 그룹에 부모가 없으면
// 자식이라도 그냥 표시한다.
function orderWithChildren(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenOf = new Map();
  const roots = [];
  for (const it of issues) {
    const pid = it.parent?.id;
    if (pid && byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(it);
    } else {
      roots.push(it);
    }
  }
  const out = [];
  for (const r of roots) {
    const kids = childrenOf.get(r.id) ?? [];
    out.push({ issue: r, indent: false, hasChildren: kids.length > 0 });
    for (const c of kids) out.push({ issue: c, indent: true, parentId: r.id });
  }
  return out;
}

// 부모 행의 caret 을 토글해 자식 행을 접거나 편다.
function toggleCollapse(wrap, parentId, caret) {
  const isCollapsed = collapsed.has(parentId);
  if (isCollapsed) collapsed.delete(parentId);
  else collapsed.add(parentId);
  caret.textContent = collapsed.has(parentId) ? "▸" : "▾";
  for (const child of wrap.querySelectorAll(`[data-child-of="${parentId}"]`)) {
    child.hidden = collapsed.has(parentId);
  }
}

function section(titleText, issues, opts = {}) {
  const wrap = el("section", { className: "group" });
  // titleText 가 null 이면(그룹 없음) 헤더를 그리지 않는다.
  if (titleText != null) {
    const header = el("div", { className: "group-title" });
    if (opts.color) {
      const dot = el("span", { className: "dot" });
      dot.style.color = opts.color;
      header.append(dot);
    }
    header.append(document.createTextNode(`${titleText} · ${issues.length}`));
    wrap.append(header);
  }
  for (const entry of orderWithChildren(issues)) {
    const row = issueRow(entry.issue, { indent: entry.indent, showProject: opts.showProject });

    // 자식 행: 부모가 접혀 있으면 숨김.
    if (entry.parentId) {
      row.dataset.childOf = entry.parentId;
      if (collapsed.has(entry.parentId)) row.hidden = true;
    }

    // 자식이 있는 부모 행: 접기/펼치기 caret 추가.
    if (entry.hasChildren) {
      const caret = el("span", { className: "caret" }, collapsed.has(entry.issue.id) ? "▸" : "▾");
      caret.title = t("panel.toggleChildren");
      caret.addEventListener("click", (e) => {
        e.stopPropagation(); // 행 클릭(이슈 열기)로 전파 방지
        toggleCollapse(wrap, entry.issue.id, caret);
      });
      row.querySelector(".issue-top").prepend(caret);
    }

    wrap.append(row);
  }
  return wrap;
}

// ---- 데이터 -----------------------------------------------------------------

async function refreshCurrentBranch() {
  const bar = document.getElementById("branchbar");
  const showBar = displayCfg.show_branch_bar !== false;
  if (bar && !showBar) bar.hidden = true;
  try {
    const info = await muxy.git.repoInfo();
    const branch = info?.currentBranch || "";
    const m = branch && branch.match(ID_RE);
    currentIssueId = m ? m[1].toUpperCase() : null;
    if (bar && showBar) {
      bar.hidden = false;
      bar.textContent = branch ? `⎇ ${branch}${info?.isWorktree ? " · worktree" : ""}` : t("panel.noBranch");
      bar.title = info?.root ? t("panel.branchLocation", { root: info.root }) : "";
    }
  } catch {
    currentIssueId = null;
    if (bar && showBar) { bar.hidden = false; bar.textContent = t("panel.notGitRepo"); bar.title = ""; }
  }
}

// 연결 정보에 따라 subbar(연결 표시 + 내이슈/전체 토글) 갱신.
function renderSubbar() {
  if (projectCfg && (projectCfg.projectId || projectCfg.teamKey)) {
    subbar.hidden = false;
    const label = projectCfg.projectName || (projectCfg.teamKey ? t("panel.teamLabel", { key: projectCfg.teamKey }) : t("panel.linked"));
    linkedEl.textContent = `📁 ${label}`;
    // 프로젝트 id 가 있어야 "프로젝트 전체"가 의미 있음
    document.getElementById("who").style.visibility = projectCfg.projectId ? "visible" : "hidden";
  } else {
    subbar.hidden = true;
  }
}

// 현재 이슈들에 존재하는 상태 목록(실제 Linear 상태명 그대로, 타입순 정렬).
function distinctStates(issues) {
  const map = new Map(); // name -> { name, type }
  for (const it of issues) {
    const name = it.state?.name;
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, type: it.state?.type ?? "unstarted" });
  }
  return [...map.values()].sort((a, b) => {
    const t = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
}

// 상태 필터 select 를 채운다(각 상태 옆에 개수 표시). 이전 선택은 유지.
function populateStateFilter() {
  const sel = document.getElementById("state-filter");
  const states = distinctStates(allIssues);
  // 이전 선택 상태가 사라졌으면 전체로.
  if (stateFilter && !states.some((s) => s.name === stateFilter)) stateFilter = "";
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = t("panel.filterAll", { n: allIssues.length });
  sel.append(optAll);
  for (const s of states) {
    const count = allIssues.filter((i) => i.state?.name === s.name).length;
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = `${s.name} (${count})`;
    sel.append(o);
  }
  sel.value = stateFilter;
}

// 우선순위 그룹 표시 순서: 긴급 → 높음 → 보통 → 낮음 → 없음(0).
const PRIORITY_GROUP_ORDER = [1, 2, 3, 4, 0];

// 정렬 기준(list_sort_by)별 비교 함수. 기본은 최근 수정순(현재 동작 유지).
function sortComparator(sortBy) {
  const byUpdated = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  if (sortBy === "created") return (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || byUpdated(a, b);
  if (sortBy === "title") return (a, b) => (a.title || "").localeCompare(b.title || "") || byUpdated(a, b);
  if (sortBy === "priority") {
    // 긴급(1)…낮음(4) → 없음(0) 마지막. 동순위는 최근 수정순.
    const rank = (p) => ({ 1: 0, 2: 1, 3: 2, 4: 3, 0: 4 }[p] ?? 5);
    return (a, b) => rank(a.priority) - rank(b.priority) || byUpdated(a, b);
  }
  if (sortBy === "status") {
    // 상태 타입 순서(진행 → 대기 → 완료 …) → 상태 이름 → 최근 수정순.
    const rank = (s) => TYPE_ORDER[s?.type] ?? 9;
    return (a, b) =>
      rank(a.state) - rank(b.state) || (a.state?.name || "").localeCompare(b.state?.name || "") || byUpdated(a, b);
  }
  return byUpdated;
}

// 이름 기준 그룹핑: 빈 값은 emptyLabel 버킷으로 모아 맨 뒤로 정렬.
function groupByName(issues, keyFn, emptyLabel) {
  const groups = new Map();
  for (const it of issues) {
    const name = keyFn(it) || emptyLabel;
    if (!groups.has(name)) groups.set(name, { title: name, issues: [] });
    groups.get(name).issues.push(it);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.title === emptyLabel) return 1;
    if (b.title === emptyLabel) return -1;
    return a.title.localeCompare(b.title);
  });
}

// 이슈들을 list_group_by 기준으로 그룹 배열 [{ title, color?, issues }] 로 만든다.
// title 이 null 이면 헤더 없는 단일 그룹(그룹 없음).
function buildGroups(issues, groupBy) {
  if (groupBy === "none") return [{ title: null, issues }];

  if (groupBy === "priority") {
    const map = new Map();
    for (const it of issues) {
      const p = [1, 2, 3, 4].includes(it.priority) ? it.priority : 0;
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(it);
    }
    return PRIORITY_GROUP_ORDER.filter((p) => map.has(p)).map((p) => ({
      title: priorityLabel(p) || t("panel.noPriority"),
      issues: map.get(p),
    }));
  }

  if (groupBy === "assignee") {
    return groupByName(issues, (it) => it.assignee?.displayName || it.assignee?.name || "", t("panel.noAssignee"));
  }
  if (groupBy === "project") {
    return groupByName(issues, (it) => it.project?.name || "", t("panel.noProject"));
  }
  if (groupBy === "milestone") {
    return groupByName(issues, (it) => it.projectMilestone?.name || "", t("panel.noMilestone"));
  }

  // status(기본): 실제 상태 이름 그대로 그룹핑(타입순 → 이름순).
  const groups = new Map();
  for (const it of issues) {
    const name = it.state?.name ?? t("panel.otherState");
    if (!groups.has(name)) {
      groups.set(name, { title: name, type: it.state?.type ?? "unstarted", color: it.state?.color, issues: [] });
    }
    groups.get(name).issues.push(it);
  }
  return [...groups.values()].sort((a, b) => {
    const d = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
    return d !== 0 ? d : a.title.localeCompare(b.title);
  });
}

// allIssues 를 stateFilter 로 걸러 선택한 그룹/정렬 기준으로 그린다(네트워크 재요청 없음).
function renderList() {
  // 폴링 갱신 시 스크롤이 튀지 않도록 위치를 보존한다.
  const prevScroll = content.scrollTop;
  content.innerHTML = "";
  const showProject = !projectCfg?.projectId;
  let filtered = stateFilter ? allIssues.filter((i) => i.state?.name === stateFilter) : allIssues;
  // 검색어(번호/제목)로 추가 필터.
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(
      (i) => i.identifier.toLowerCase().includes(q) || (i.title || "").toLowerCase().includes(q),
    );
  }

  if (filtered.length === 0) {
    content.append(emptyBox());
    return;
  }

  // 현재 브랜치 이슈를 최상단으로 분리(그룹/정렬 방식과 무관하게 강조).
  const current = filtered.find((i) => i.identifier === currentIssueId);
  const rest = filtered.filter((i) => i.identifier !== currentIssueId);
  if (current) content.append(section(t("panel.currentBranch"), [current], { showProject }));

  // 선택한 기준으로 그룹핑 + 그룹 내 정렬(자식 중첩은 section 이 처리).
  const cmp = sortComparator(displayCfg.list_sort_by || "updated");
  const groups = buildGroups(rest, displayCfg.list_group_by || "status");
  for (const g of groups) {
    const ordered = g.issues.slice().sort(cmp);
    content.append(section(g.title, ordered, { showProject, color: g.color }));
  }
  content.scrollTop = prevScroll; // 재그리기 후 스크롤 위치 복원
}

// 현재 뷰(who/projectCfg) 기준으로 이슈 목록만 가져온다. render 와 폴링이 공유.
async function fetchIssueList(token, config) {
  const useProjectAll = !!projectCfg?.projectId && who === "all";
  if (useProjectAll) {
    return fetchProjectIssues(token, { projectId: projectCfg.projectId, activeOnly: false });
  }
  return fetchMyIssues(token, {
    teamKey: projectCfg?.teamKey || config.team_key,
    projectId: projectCfg?.projectId || "",
    activeOnly: false,
  });
}

// 렌더 결과에 영향을 주는 값만 뽑아 시그니처를 만든다. 값이 같으면 DOM 을 건드리지 않는다.
function issuesSignature(issues) {
  const d = displayCfg;
  return JSON.stringify({
    cur: currentIssueId,
    // 표시에 영향 주는 설정/언어. 이게 바뀌면(설정 변경 등) 목록을 다시 그려야 한다.
    view: [
      getLang(), d.list_show_parent, d.list_show_state, d.list_show_priority,
      d.list_show_project, d.list_show_milestone, d.list_show_assignee, d.list_show_actions,
      d.list_group_by, d.list_sort_by,
      !!d.api_token, !!d.agent_command, JSON.stringify(d.actions || null),
    ],
    items: issues.map((i) => [
      i.identifier, i.state?.name, i.state?.color, i.title, i.priority,
      i.assignee?.displayName || i.assignee?.name || "",
      i.parent?.identifier || "", i.projectMilestone?.name || "", i.project?.name || "",
    ]),
  });
}

// 폴링용 경량 새로고침: 스피너 없이 조용히 데이터를 가져와 바뀐 경우에만 다시 그린다.
// 연결/키 상태 등 구조가 바뀌는 변경은 여기서 다루지 않고 render() 가 담당한다.
// NOTE: document.hidden 로는 가드하지 않는다. muxy 패널은 여러 웹뷰 중 하나라, 화면에
// 보이는 상태에서도 Page Visibility API 상 hidden 으로 잡혀 폴링이 통째로 막힌다(자동
// 새로고침이 안 되는 원인이었다). 지속 폴링이 요구사항이므로 항상 돌린다.
async function pollTick() {
  if (busy || !listReady || !currentToken) return;
  busy = true;
  try {
    const config = await loadConfig();
    await refreshCurrentBranch();
    const { issues } = await fetchIssueList(currentToken, config);
    const sig = issuesSignature(issues);
    if (sig === lastSignature) return; // 변경 없음 → DOM 유지(스크롤/포커스 보존)
    lastSignature = sig;
    allIssues = issues;
    populateStateFilter();
    renderList(); // 스크롤 위치를 보존한 채 목록만 교체
  } catch (e) {
    // 폴링 실패는 조용히 무시하고 기존 목록을 유지한다(콘솔에만 기록).
    console.warn("[linear] auto-refresh 실패:", e?.message || e);
  } finally {
    busy = false;
  }
}

// 리스트가 이미 떠 있으면 깜빡임 없는 경량 갱신, 아니면 전체 렌더(안내 화면 등).
function refreshSmart() {
  if (listReady) pollTick();
  else render();
}

// 새로고침 버튼 전용: 수동 갱신은 스피너를 돌려 눌린 것을 시각적으로 알린다.
// (자동 폴링/이벤트 갱신은 조용히 유지 → 여기서만 setLoading 을 쓴다.)
async function manualRefresh() {
  if (!listReady) { render(); return; } // render() 가 자체 스피너를 표시
  setLoading(true);
  try {
    await pollTick();
  } finally {
    setLoading(false);
  }
}

// 폴링 시작(중복 방지). pollTick 이 busy/listReady/currentToken 을 스스로 가드한다.
// active 게이트는 자동 폴링에만 적용한다 → 비활성(가려진) 패널은 요청을 멈추되,
// 새로고침 버튼/이벤트 기반 refreshSmart 는 게이트와 무관하게 항상 동작한다.
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (active) pollTick(); }, POLL_MS);
}

async function render() {
  busy = true;
  const wasReady = listReady;    // 직전에 목록이 떠 있었나
  const prevSig = lastSignature; // 직전에 그린 데이터 시그니처
  listReady = false;
  // 기존 목록을 비우지 않는다(깜빡임 방지). 로딩 중임은 상단바 스피너로만 표시하고,
  // 데이터가 실제로 바뀐 경우에만 renderList()가 그 자리에서 교체한다(설정 닫기 등에서
  // 동일 데이터를 다시 그려 깜빡이던 문제 제거). 첫 로드라 목록이 비어 있으면 스피너만 보인다.
  setLoading(true);

  const config = await loadConfig();
  setLang(config.language);
  applyStaticI18n();
  const searchbar = document.getElementById("searchbar");

  try {
    projectCfg = await readProjectConfig();
    const token = effectiveToken(config, projectCfg); // 프로젝트 전용 키 우선
    // 실효 설정: 프로젝트 핵심 실행값 오버라이드 + 액션 병합 + 실효 토큰(모달에도 이 토큰을 넘긴다).
    displayCfg = { ...applyProjectSettings(config, projectCfg), actions: mergeActions(config.actions, projectCfg?.actions) };
    populateDisplayMenu(); // 그룹/정렬 팝오버를 현재 값으로 채운다
    await refreshCurrentBranch();

    // 프로젝트가 Linear에 연결(.linear.json)되지 않았으면 리스트를 숨기고 연결 안내.
    if (!projectCfg) {
      subbar.hidden = true;
      if (searchbar) searchbar.hidden = true;
      content.innerHTML = "";
      const box = el("div", { className: "empty" }, [
        el("p", {}, t("panel.notLinkedTitle")),
        el("p", { className: "muted", style: "font-size:12px" }, t("panel.notLinkedHint")),
        el("button", { className: "primary", onclick: openSettings }, t("panel.connectInSettings")),
      ]);
      content.append(box);
      return;
    }

    // 전역 키도 프로젝트 키도 없으면 키 필요 안내.
    if (!token) {
      subbar.hidden = true;
      if (searchbar) searchbar.hidden = true;
      content.innerHTML = "";
      const box = el("div", { className: "empty" }, [
        el("p", {}, t("panel.needKeyTitle")),
        el("p", { className: "muted", style: "font-size:12px" }, t("panel.needKeyHint")),
        el("button", { className: "primary", onclick: openSettings }, t("panel.openSettings")),
      ]);
      content.append(box);
      return;
    }
    if (searchbar) searchbar.hidden = false;

    renderSubbar();

    // 상태 필터를 클라이언트에서 걸 수 있도록 모든 상태의 이슈를 가져온다.
    const { issues } = await fetchIssueList(token, config);
    allIssues = issues;
    console.log(`[linear] who=${who} count=${issues.length}`);

    populateStateFilter();
    // 직전에도 목록이 떠 있었고 데이터가 같으면 다시 그리지 않는다 → 목록 유지, 깜빡임 없음.
    const sig = issuesSignature(issues);
    if (!wasReady || sig !== prevSig) renderList();
    // 폴링에서 재사용할 토큰/시그니처 기록 + 리스트 표시 상태 on.
    currentToken = token;
    listReady = true;
    lastSignature = sig;
  } catch (err) {
    content.innerHTML = "";
    content.append(errorBox(err));
  } finally {
    busy = false;
    setLoading(false);
  }
}

// 리스트가 비었을 때, 사유별 안내.
function emptyBox() {
  const q = searchQuery.trim();
  if (q) return el("div", { className: "empty muted" }, t("panel.searchNoResult", { q }));
  if (stateFilter) {
    return el("div", { className: "empty muted" }, t("panel.noStateIssues", { state: stateFilter }));
  }
  // 프로젝트 연결됨 + 비어 있음
  if (projectCfg?.projectId) {
    const box = el("div", { className: "empty" }, [
      el("p", {}, t("panel.noProjectIssues", { name: projectCfg.projectName || "" })),
      el("p", { className: "muted", style: "font-size:12px" }, who === "mine" ? t("panel.checkAllToggle") : ""),
    ]);
    return box;
  }
  // 프로젝트 미연결
  const box = el("div", { className: "empty" }, [
    el("p", {}, t("panel.noIssues")),
    el("p", { className: "muted", style: "font-size:12px" }, t("panel.noIssuesHint")),
  ]);
  box.append(el("button", { onclick: openLink }, t("panel.linkProject")));
  return box;
}

// 로드 실패 사유별 안내(네트워크 / 인증 / 기타).
function errorBox(err) {
  const code = err?.code;
  let title, hint, btn;
  if (code === "network") {
    title = t("panel.errNetworkTitle");
    hint = t("panel.errNetworkHint");
    btn = { label: t("common.retry"), fn: render };
  } else if (code === "rate") {
    title = t("panel.errRateTitle");
    const secs = Number(err?.retryAfter);
    hint = Number.isFinite(secs) && secs > 0
      ? t("panel.errRateHintRetry", { secs })
      : t("panel.errRateHint");
    btn = { label: t("common.retry"), fn: render };
  } else if (code === "auth") {
    title = t("panel.errAuthTitle");
    hint = t("panel.errAuthHint");
    btn = { label: t("panel.openSettingsShort"), fn: openSettings };
  } else {
    title = t("panel.errLoadTitle");
    hint = err?.message || String(err);
    btn = { label: t("common.retry"), fn: render };
  }
  const box = el("div", { className: "empty" }, [
    el("p", { style: "font-weight:600" }, title),
    el("p", { className: "muted", style: "font-size:12px" }, hint),
  ]);
  box.append(el("button", { className: "primary", onclick: btn.fn }, btn.label));
  return box;
}

// ---- 모달 열기 --------------------------------------------------------------

async function openIssue(issue) {
  const config = await loadConfig();
  // 실효 토큰 + 액션(글로벌+프로젝트 병합)을 상세 화면에 전달.
  const eff = { ...applyProjectSettings(config, projectCfg), actions: mergeActions(config.actions, projectCfg?.actions) };
  // KNK-71: 이슈 상세를 좁은 모달 대신 풀 탭 웹뷰로 연다(같은 issue.js 컴포넌트 재사용).
  // 탭 안에서 상태가 바뀌면 패널 폴링(3초)이 목록을 자동 갱신하므로 결과 처리가 따로 필요 없다.
  // extensionWebView 를 지원하지 않는 구버전 muxy 에서는 예외를 잡아 기존 모달로 폴백한다.
  try {
    await muxy.tabs.open({
      kind: "extensionWebView",
      extension: { id: "linear", tabType: "issue", data: { issue, config: eff, mode: "tab" } },
    });
    return;
  } catch (e) {
    console.warn("[linear] 이슈를 탭으로 열기 실패 → 모달로 폴백:", e?.message || e);
  }
  const result = await muxy.modal.openWebview({
    entry: "modals/issue.html",
    width: 820,
    height: 760,
    data: { issue, config: eff },
  });
  if (result?.changed) render();
}

// 검색어를 이슈 식별자로 해석해 정확히 그 이슈를 연다(목록에 없으면 서버 조회).
async function openExact() {
  const raw = searchQuery.trim();
  if (!raw) return;
  const config = await loadConfig();
  const token = effectiveToken(config, projectCfg);
  let id = raw.toUpperCase();
  // 숫자만 입력하면 팀 키를 붙인다(예: 534 → KYL-534).
  if (/^\d+$/.test(raw)) {
    const tk = (projectCfg?.teamKey || config.team_key || "").toUpperCase();
    if (tk) id = `${tk}-${raw}`;
  }
  const inList = allIssues.find((i) => i.identifier.toUpperCase() === id);
  if (inList) return openIssue(inList);
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) {
    muxy.toast?.({ title: t("panel.searchToast"), body: t("panel.searchToastBody") });
    return;
  }
  try {
    const iss = await fetchIssueById(token, id);
    if (iss) openIssue(iss);
    else muxy.toast?.({ title: t("panel.noIssueToast"), body: id });
  } catch (e) {
    muxy.toast?.({ title: t("panel.searchFailToast"), body: e?.message || String(e) });
  }
}

async function openSettings() {
  await muxy.modal.openWebview({ entry: "modals/settings.html", width: 460, height: 520 });
  render();
}

async function openCreate() {
  const result = await muxy.modal.openWebview({ entry: "modals/create.html", width: 460, height: 420 });
  if (result?.created) render();
}

async function openLink() {
  const result = await muxy.modal.openWebview({ entry: "modals/link.html", width: 460, height: 460 });
  if (result?.saved || result?.cleared) {
    who = "mine"; // 연결 변경 시 기본 뷰로
    render();
  }
}

// ---- 이벤트 바인딩 ----------------------------------------------------------

function bindSeg(id, apply) {
  document.getElementById(id).addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    for (const b of document.querySelectorAll(`#${id} .seg-btn`)) {
      b.classList.toggle("is-active", b === btn);
    }
    apply(btn.dataset);
    render();
  });
}

// 상태 필터: 재요청 없이 클라이언트에서 즉시 필터링.
document.getElementById("state-filter").addEventListener("change", (e) => {
  stateFilter = e.target.value;
  renderList();
});

// 이슈 검색: 입력 시 목록 필터, Enter 시 정확히 그 번호 이슈 열기.
const searchEl = document.getElementById("search");
searchEl.addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderList();
});
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    openExact();
  }
});

// 연결된 프로젝트에서 "내 이슈 / 프로젝트 전체" 는 쿼리가 달라 재요청.
bindSeg("who", (d) => { who = d.who; });

// 수동 새로고침: 스피너를 표시하며 갱신(버튼을 누른 것을 시각적으로 알림).
document.getElementById("refresh").addEventListener("click", manualRefresh);
document.getElementById("new").addEventListener("click", openCreate);
document.getElementById("settings").addEventListener("click", openSettings);

// 그룹/정렬(Display) 팝오버: 버튼으로 토글, 바깥 클릭 시 닫기.
const displayBtn = document.getElementById("display");
const displayMenu = document.getElementById("display-menu");
displayBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  displayMenu.hidden = !displayMenu.hidden;
});
document.addEventListener("click", (e) => {
  if (displayMenu.hidden) return;
  if (e.target === displayBtn || displayMenu.contains(e.target)) return;
  displayMenu.hidden = true;
});

// 그룹/정렬 선택: 전역 설정으로 저장하고 즉시 다시 그린다(재요청 없음).
async function setDisplayOption(key, value) {
  displayCfg[key] = value;
  await saveConfig({ [key]: value });
  renderList();
  lastSignature = issuesSignature(allIssues); // 폴링이 같은 이유로 다시 그리지 않도록 갱신
}
document.getElementById("group-by").addEventListener("change", (e) => setDisplayOption("list_group_by", e.target.value));
document.getElementById("sort-by").addEventListener("change", (e) => setDisplayOption("list_sort_by", e.target.value));

// 프로젝트/브랜치 전환 시 현재 브랜치 강조 + 연결 정보 갱신.
// 구독 실패(권한 등)가 최초 렌더링을 막지 않도록 방어한다.
function safeSubscribe(name, handler) {
  try {
    muxy.events.subscribe(name, handler);
  } catch (e) {
    console.warn(`events.subscribe(${name}) 실패:`, e.message);
  }
}
// 브랜치 변경은 목록 구조가 그대로라 경량 갱신으로 충분(현재 브랜치 강조만 반영).
safeSubscribe("worktree.headChanged", refreshSmart);
// 프로젝트 전환은 연결 대상 자체가 바뀌므로 전체 렌더로 다시 구성한다.
safeSubscribe("project.switched", render);

// 포커스 상태로 폴링을 게이트한다. 비활성(뒤에 가려진) 패널은 요청을 멈춰 Linear
// 요청 한도를 아끼고, 다시 활성화되면 즉시 한 번 새로고침해 밀린 변경을 반영한다.
try {
  muxy.onFocus?.((focused) => {
    active = !!focused;
    if (active) refreshSmart(); // 포커스 복귀 시 즉시 최신화(그 후 폴링이 이어감)
  });
} catch { /* onFocus 없으면 무시 → active=true 로 항상 폴링 */ }

render();
startPolling(); // 최소 1초 간격으로 신규 데이터를 지속적으로 가져온다.
