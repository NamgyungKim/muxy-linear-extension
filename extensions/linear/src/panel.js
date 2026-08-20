// Linear 패널: 나에게 assign 된 이슈 목록 + 현재 브랜치 이슈 강조 + 이슈 클릭 시
// 상세/작업시작 모달 오픈. 프로젝트가 .linear.json 으로 연결돼 있으면 그 Linear
// 프로젝트로 자동 필터한다.

import "./theme.css";
import "./panel.css";
import { installFatalHandler } from "./fatal.js";
import { loadConfig, effectiveToken, applyProjectSettings } from "./config.js";
import { fetchMyIssues, fetchProjectIssues, fetchIssueById } from "./linear.js";
import { readProjectConfig } from "./project.js";
import { getActiveWork, clearActiveWork, isActiveIssue } from "./worklock.js";
import { applicableActions, runAction, mergeActions } from "./actions.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const content = document.getElementById("content");
const subbar = document.getElementById("subbar");
const linkedEl = document.getElementById("linked");

// 예상치 못한 오류를 content 영역에 드러낸다.
installFatalHandler("content");

let who = "mine"; // mine | all (연결된 프로젝트에서 내 이슈만/전체)
let currentIssueId = null; // 현재 git 브랜치에 해당하는 이슈 identifier
let projectCfg = null; // .linear.json 내용(연결 정보) 또는 null
let displayCfg = {}; // 목록 표시 옵션(config 의 list_* 값)
let allIssues = []; // 마지막으로 가져온 이슈 전체(상태 필터는 클라이언트에서 적용)
let stateFilter = ""; // 선택된 상태 이름("" = 전체)
let searchQuery = ""; // 이슈 검색어(번호/제목)
let activeWork = null; // 진행 중인 작업 { issueId, identifier, branch } 또는 null
const collapsed = new Set(); // 접힌 부모 이슈 id 집합(자식 숨김)

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
  setTitle("new", "panel.newIssueTitle");
  setTitle("refresh", "panel.refreshTitle");
  setTitle("settings", "panel.settingsTitle");
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
  if (state?.color) dot.style.color = state.color;
  badge.append(dot, document.createTextNode(state?.name ?? "—"));
  return badge;
}

function issueRow(issue, { indent = false, showProject = false } = {}) {
  const row = el("button", { className: "issue" });
  if (issue.identifier === currentIssueId) row.classList.add("is-current");
  if (indent) row.classList.add("is-child");
  const active = isActiveIssue(activeWork, issue); // 이 이슈가 진행 중인가
  if (active) row.classList.add("is-active-work");

  // 부모 이슈가 있으면 상단에 브레드크럼 표시.
  if (displayCfg.list_show_parent && issue.parent) {
    row.append(el("div", { className: "issue-parent" }, `↳ ${issue.parent.identifier} ${issue.parent.title}`));
  }

  const top = el("div", { className: "issue-top" });
  top.append(el("span", { className: "issue-id" }, issue.identifier));
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
  // 진행 중 표시(작은 자물쇠)
  if (active) top.append(el("span", { className: "lock-tag", title: t("panel.inProgressTitle") }, "🔒"));

  // 현재 상태에 해당하는 액션 버튼들.
  // API 키와 에이전트가 모두 설정돼 있어야 액션을 쓸 수 있으므로, 없으면 버튼 자체를 숨긴다.
  const actionsReady = !!displayCfg.api_token && !!displayCfg.agent_command;
  if (displayCfg.list_show_actions && actionsReady) {
    const acts = el("span", { className: "issue-acts" });
    for (const a of applicableActions(displayCfg.actions, issue)) {
      const b = el("button", { className: "row-btn", title: a.label }, a.icon ? `${a.icon} ${a.label}` : a.label);
      const reason = actionBlockedReason(a, issue);
      if (reason) { b.disabled = true; b.title = reason; }
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

// 잠금 규칙상 이 액션을 지금 못 누르는 이유(없으면 null).
// 현재 git 브랜치가 이 이슈의 브랜치면(currentIssueId 일치) "진행 중"으로 인정한다.
function actionBlockedReason(action, issue) {
  const onBranch = !!currentIssueId && issue.identifier === currentIssueId;
  const inProgress = isActiveIssue(activeWork, issue) || onBranch;
  if (action.lock === "start" && activeWork && activeWork.issueId !== issue.id) {
    return t("lock.finishFirst", { id: activeWork.identifier });
  }
  if (action.lock === "end" && !inProgress) {
    return t("lock.notInProgress");
  }
  return null;
}

// 행에서 액션 실행.
async function runRowAction(action, issue) {
  const config = await loadConfig();
  const onBranch = !!currentIssueId && issue.identifier === currentIssueId;
  try {
    const res = await runAction(action, issue, config, {
      onBranch,
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
    if (res.blocked) { muxy.toast?.({ title: t("panel.cannotRun"), body: res.reason }); return; }
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

// 진행 중 배너: 무엇이 잠겨 있는지 + 수동 해제.
function renderWorklock() {
  const bar = document.getElementById("worklock");
  if (!activeWork) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = "";
  bar.append(el("span", { className: "wl-text" }, t("worklock.banner", { id: activeWork.identifier })));
  bar.append(el("span", { className: "spacer" }));
  const unlock = el("button", { className: "mini", title: t("worklock.unlockTitle") }, t("worklock.unlock"));
  unlock.addEventListener("click", async () => {
    const choice = await muxy.dialog.confirm({
      title: t("worklock.unlock"),
      message: t("worklock.unlockConfirm", { id: activeWork.identifier }),
      buttons: [t("worklock.unlockYes"), t("common.cancel")],
      cancel: t("common.cancel"),
    });
    if (choice !== t("worklock.unlockYes")) return;
    await clearActiveWork();
    render();
  });
  bar.append(unlock);
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
  const header = el("div", { className: "group-title" });
  if (opts.color) {
    const dot = el("span", { className: "dot" });
    dot.style.color = opts.color;
    header.append(dot);
  }
  header.append(document.createTextNode(`${titleText} · ${issues.length}`));
  wrap.append(header);
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

// allIssues 를 stateFilter 로 걸러 상태별 그룹으로 그린다(네트워크 재요청 없음).
function renderList() {
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

  // 현재 브랜치 이슈를 최상단으로 분리.
  const current = filtered.find((i) => i.identifier === currentIssueId);
  const rest = filtered.filter((i) => i.identifier !== currentIssueId);
  if (current) content.append(section(t("panel.currentBranch"), [current], { showProject }));

  // 실제 상태 이름 그대로 그룹핑(타입순 → 이름순).
  const groups = new Map();
  for (const it of rest) {
    const name = it.state?.name ?? t("panel.otherState");
    if (!groups.has(name)) {
      groups.set(name, { name, type: it.state?.type ?? "unstarted", color: it.state?.color, issues: [] });
    }
    groups.get(name).issues.push(it);
  }
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const t = (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
    return t !== 0 ? t : a.name.localeCompare(b.name);
  });
  for (const g of sortedGroups) {
    content.append(section(g.name, g.issues, { showProject, color: g.color }));
  }
}

let rendering = false; // render 진행 중 여부(자동 새로고침 중복 실행 방지)

async function render(opts = {}) {
  const silent = opts.silent === true; // 자동 새로고침은 로딩 스피너를 띄우지 않고 조용히 갱신
  rendering = true;
  if (!silent) {
    content.innerHTML = "";
    content.append(el("div", { className: "loading muted" }, t("common.loading")));
  }

  const config = await loadConfig();
  setLang(config.language);
  applyStaticI18n();
  scheduleAutoRefresh(config.auto_refresh_seconds); // 설정된 주기로 자동 새로고침 예약(매 렌더마다 타이머 리셋)
  const searchbar = document.getElementById("searchbar");

  try {
    projectCfg = await readProjectConfig();
    const token = effectiveToken(config, projectCfg); // 프로젝트 전용 키 우선
    // 실효 설정: 프로젝트 핵심 실행값 오버라이드 + 액션 병합 + 실효 토큰(모달에도 이 토큰을 넘긴다).
    displayCfg = { ...applyProjectSettings(config, projectCfg), actions: mergeActions(config.actions, projectCfg?.actions) };
    activeWork = await getActiveWork();
    await refreshCurrentBranch();

    // 프로젝트가 Linear에 연결(.linear.json)되지 않았으면 리스트를 숨기고 연결 안내.
    if (!projectCfg) {
      subbar.hidden = true;
      if (searchbar) searchbar.hidden = true;
      renderWorklock();
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
      renderWorklock();
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
    renderWorklock();

    const projectFiltered = !!projectCfg?.projectId;
    const useProjectAll = projectFiltered && who === "all";
    // 상태 필터를 클라이언트에서 걸 수 있도록 모든 상태의 이슈를 가져온다.
    let issues;
    if (useProjectAll) {
      ({ issues } = await fetchProjectIssues(token, {
        projectId: projectCfg.projectId,
        activeOnly: false,
      }));
    } else {
      ({ issues } = await fetchMyIssues(token, {
        teamKey: projectCfg?.teamKey || config.team_key,
        projectId: projectCfg?.projectId || "",
        activeOnly: false,
      }));
    }
    allIssues = issues;
    console.log(`[linear] path=${useProjectAll ? "projectAll" : "mine"} who=${who} count=${issues.length}`);

    populateStateFilter();
    renderList();
  } catch (err) {
    content.innerHTML = "";
    content.append(errorBox(err));
  } finally {
    rendering = false;
  }
}

// 자동 새로고침 타이머. auto_refresh_seconds(0=끔)마다 조용히 목록을 다시 가져온다.
// 매 render 마다 호출되어 타이머를 리셋하므로, 수동 새로고침·포커스·이벤트 갱신 직후
// 다음 자동 새로고침까지 온전한 주기가 확보된다.
let autoRefreshTimer = null;
function scheduleAutoRefresh(seconds) {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return; // 0 이하 또는 잘못된 값이면 자동 새로고침 끔
  const ms = Math.max(10, n) * 1000; // 과도한 폴링 방지를 위해 최소 10초
  autoRefreshTimer = setInterval(() => {
    // 패널이 안 보이거나 렌더링 중이면 건너뛴다(불필요한 API 호출 방지).
    if (document.hidden || rendering) return;
    render({ silent: true });
  }, ms);
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
  // 실효 토큰 + 액션(글로벌+프로젝트 병합)을 모달에 전달.
  const eff = { ...applyProjectSettings(config, projectCfg), actions: mergeActions(config.actions, projectCfg?.actions) };
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

document.getElementById("refresh").addEventListener("click", render);
document.getElementById("new").addEventListener("click", openCreate);
document.getElementById("settings").addEventListener("click", openSettings);

// 프로젝트/브랜치 전환 시 현재 브랜치 강조 + 연결 정보 갱신.
// 구독 실패(권한 등)가 최초 렌더링을 막지 않도록 방어한다.
function safeSubscribe(name) {
  try {
    muxy.events.subscribe(name, render);
  } catch (e) {
    console.warn(`events.subscribe(${name}) 실패:`, e.message);
  }
}
safeSubscribe("worktree.headChanged");
safeSubscribe("project.switched");

// 패널이 다시 활성화(포커스)될 때 자동 새로고침 — 터미널/Linear 웹 등 외부 변경 반영.
try {
  muxy.onFocus?.((focused) => { if (focused) render(); });
} catch { /* onFocus 없으면 무시 */ }

render();
