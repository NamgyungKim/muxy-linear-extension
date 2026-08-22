// 이슈 상세 모달: 상태 변경 / 본문·코멘트 보기(마크다운) / 상태별 액션 실행.
// 열림 데이터: window.muxy.data = { issue, config }

import "./theme.css";
import "./modal.css";
import { run } from "./fatal.js";
import {
  fetchTeamStates, updateIssueState, createComment, fetchIssueDetail,
  updateIssueDescription, updateIssueTitle,
  fetchTeamMembers, fetchTeamLabels, fetchTeamProjects,
  updateIssueAssignee, updateIssuePriority, updateIssueLabels, updateIssueProject, deleteIssue,
} from "./linear.js";
import { renderMarkdown } from "./markdown.js";
import { listBaseBranchCandidates, defaultBranch } from "./git.js";
import { applicableActions, runAction } from "./actions.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const app = document.getElementById("app");
// KNK-89: 싱글턴 탭이 다른 이슈로 재사용되면 onDataChange 로 새 데이터가 들어온다.
// 그때 아래 두 값을 갈아끼우고 다시 렌더하므로 const 가 아니라 let 으로 둔다.
let { issue, config } = muxy.data || {};
// 같은 컴포넌트를 모달(muxy.modal.openWebview) 과 탭(muxy.tabs.open extensionWebView)
// 양쪽에서 재사용한다. 탭으로 열리면 data.mode === "tab" 로 구분한다.
const asTab = muxy.data?.mode === "tab";
setLang(config?.language); // 패널이 넘긴 config 로 언어 적용

let changed = false; // 목록 갱신이 필요한 변경이 있었는지

function h(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function toast(title, body) {
  muxy.toast?.({ title, body });
}

// 이슈 URL 을 Muxy 내장 브라우저가 아니라 외부에서 연다(macOS `open`).
// Linear 데스크톱 앱이 설치돼 있으면 앱으로 열고, 없으면 기본 브라우저로 폴백한다.
async function openIssueUrl(url) {
  try {
    const r = await muxy.exec(["open", "-a", "Linear", url]);
    if (r?.exitCode === 0) return; // 앱에서 열림
  } catch {
    /* 앱 미설치 등 → 브라우저로 폴백 */
  }
  await muxy.exec(["open", url]); // 기본 브라우저
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const runLabel = (r) => ({ worktree: t("run.worktree"), branch: t("run.branch"), current: t("run.current") }[r]);

async function main() {
  if (!issue) {
    app.textContent = t("issue.cannotLoad");
    return;
  }

  // 탭으로 열렸으면 탭 제목을 이슈 식별자로 바꾼다(구버전엔 setTitle 없음 → 무시).
  if (asTab) {
    try { muxy.tabs?.setTitle?.(issue.identifier); } catch { /* setTitle 미지원 무시 */ }
  }

  app.innerHTML = `
    <header class="m-head">
      <div class="m-id">${escapeHtml(issue.identifier)}</div>
      <button id="open-web" class="icon-btn" title="${t("issue.openInLinear")}">↗</button>
      <button id="delete" class="icon-btn danger" title="${t("issue.delete")}">🗑</button>
    </header>
    <textarea id="title-input" class="m-title seamless" rows="1" spellcheck="false">${escapeHtml(issue.title)}</textarea>
    ${issue.projectMilestone?.name ? `<div class="issue-meta"><span class="chip">◆ ${escapeHtml(issue.projectMilestone.name)}</span></div>` : ""}

    <div class="props">
      <div class="field">
        <span class="label">${t("issue.state")}</span>
        <select id="state"><option>${t("common.loading")}</option></select>
      </div>
      <div class="field">
        <span class="label">${t("issue.assignee")}</span>
        <select id="assignee"><option>${t("common.loading")}</option></select>
      </div>
      <div class="field">
        <span class="label">${t("issue.priority")}</span>
        <select id="priority"></select>
      </div>
      <div class="field">
        <span class="label">${t("issue.project")}</span>
        <select id="project"><option>${t("common.loading")}</option></select>
      </div>
    </div>

    <div class="field">
      <span class="label">${t("issue.labels")}</span>
      <div id="labels" class="label-chips muted">${t("common.loading")}</div>
    </div>

    <div class="field">
      <span class="label">${t("issue.body")} <span class="muted" style="font-weight:400;font-size:11px">${t("issue.clickToEdit")}</span></span>
      <div id="desc" class="md doc muted" title="${t("issue.clickToEditTitle")}">${t("common.loading")}</div>
      <textarea id="desc-input" class="seamless" hidden></textarea>
    </div>

    <hr class="sep" />
    <div class="row" style="margin-bottom:6px">
      <h3 class="sec-title" style="margin:0">${t("issue.subIssues")}</h3>
      <span class="spacer"></span>
      <button id="add-sub" class="mini">${t("issue.addSubIssue")}</button>
    </div>
    <div id="sub-issues" class="sub-issues muted">${t("common.loading")}</div>

    <hr class="sep" />
    <h3 class="sec-title">${t("issue.comments")}</h3>
    <div id="comments" class="comments muted">${t("common.loading")}</div>
    <div class="field" style="margin-top:10px">
      <textarea id="comment" class="seamless" placeholder="${t("issue.commentPlaceholder")}"></textarea>
      <div class="row" id="comment-actions" hidden style="margin-top:6px">
        <span class="spacer"></span>
        <button id="add-comment" class="primary">${t("issue.addComment")}</button>
      </div>
    </div>

    <hr class="sep" />
    <div class="row" style="margin-bottom:6px">
      <h3 class="sec-title" style="margin:0">${t("issue.actions")}</h3>
      <span class="spacer"></span>
      <button id="edit-actions" class="mini">${t("issue.editActions")}</button>
    </div>
    <div class="field">
      <span class="label">${t("issue.branchName")}</span>
      <input type="text" id="branch" />
    </div>
    <div class="field">
      <span class="label">${t("issue.baseBranch")}</span>
      <select id="base"></select>
    </div>
    <div id="actions" class="actions-list"></div>

    <p id="err" class="error" hidden></p>
    <div class="actions">
      <button id="cancel">${t("common.close")}</button>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const errEl = $("err");
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  // 여러 줄 입력을 내용 높이에 맞춰 자동으로 늘린다(스크롤바 없이) → 편집 시 박스가
  // 튀어나오지 않고 문서처럼 자연스럽게 늘어난다.
  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  // 제목: Linear 처럼 항상 인라인 편집 필드. 포커스 아웃 또는 Enter 로 저장한다.
  const titleEl = $("title-input");
  autoGrow(titleEl);
  titleEl.addEventListener("input", () => autoGrow(titleEl));
  let titleSaving = false;
  async function saveTitle() {
    if (titleSaving) return;
    const next = titleEl.value.trim();
    // 비었거나 그대로면 원래 제목으로 되돌리고 저장하지 않는다.
    if (!next || next === issue.title) { titleEl.value = issue.title; autoGrow(titleEl); return; }
    titleSaving = true;
    try {
      await updateIssueTitle(config.api_token, issue.id, next);
      issue.title = next;
      changed = true;
      if (asTab) { try { muxy.tabs?.setTitle?.(issue.identifier); } catch { /* setTitle 미지원 무시 */ } }
      toast(t("issue.titleSaved"), issue.identifier);
    } catch (e) {
      showErr(e.message);
      titleEl.value = issue.title;
      autoGrow(titleEl);
    } finally {
      titleSaving = false;
    }
  }
  titleEl.addEventListener("blur", saveTitle);
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); titleEl.blur(); } // Enter 저장, Shift+Enter 줄바꿈
    else if (e.key === "Escape") { titleEl.value = issue.title; autoGrow(titleEl); titleEl.blur(); }
  });

  // 브랜치 기본값
  $("branch").value = defaultBranch(issue);

  // 베이스 브랜치 후보 채우기
  listBaseBranchCandidates().then((branches) => {
    const sel = $("base");
    sel.innerHTML = "";
    const list = branches.length ? branches : [config.default_base_branch];
    if (!list.includes(config.default_base_branch)) list.unshift(config.default_base_branch);
    for (const b of list) {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      if (b === config.default_base_branch) opt.selected = true;
      sel.append(opt);
    }
  });

  // 상태별 액션 버튼 렌더
  function renderActions() {
    const box = $("actions");
    box.innerHTML = "";
    // API 키와 에이전트가 모두 설정돼 있어야 액션 사용 가능.
    if (!config.api_token || !config.agent_command) {
      box.append(h(`<div class="muted">${t("issue.actionsNeedSetup")}</div>`));
      return;
    }
    const list = applicableActions(config.actions, issue);
    if (!list.length) {
      box.append(h(`<div class="muted">${escapeHtml(t("issue.noActionsForState", { name: issue.state?.name ?? "" }))}</div>`));
      return;
    }
    for (const a of list) {
      const item = h(`<div class="action-item"></div>`);
      const btn = h(`<button class="primary"></button>`);
      btn.textContent = a.icon ? `${a.icon} ${a.label}` : a.label;
      btn.addEventListener("click", () => runModalAction(a, btn));
      const meta = h(`<div class="hint"></div>`);
      meta.textContent = `${runLabel(a.run) ?? a.run}${a.toState ? ` · → ${a.toState}` : ""}`;
      item.append(btn, meta);
      box.append(item);
    }
  }

  // 한 번에 하나의 액션만 실행(중복 클릭 방지).
  let actionRunning = false;

  // 액션 실행: 진행 중에는 버튼을 "작업 중…"(스피너)으로 표기하고 나머지 버튼을 잠근다.
  // 완료되면(터미널 실행 + 상태 변경까지) 그 결과를 UI에 반영한다. 모달은 닫지 않고
  // 열어 둔 채로 갱신해, 방금 명령한 액션이 끝났고 상태가 바뀐 것을 눈으로 확인하게 한다.
  async function runModalAction(action, btn) {
    if (actionRunning) return;
    actionRunning = true;
    showErr("");
    const allBtns = [...$("actions").querySelectorAll("button")];
    allBtns.forEach((b) => (b.disabled = true));
    const origHtml = btn.innerHTML;
    btn.classList.add("running");
    btn.innerHTML = `<span class="action-spin"></span>${escapeHtml(t("issue.actionRunning"))}`;

    const restore = () => {
      btn.classList.remove("running");
      btn.innerHTML = origHtml;
      allBtns.forEach((b) => (b.disabled = false));
    };

    try {
      const res = await runAction(action, issue, config, {
        branch: $("branch").value.trim(),
        base: $("base").value,
        confirmFn: (a, prompt) =>
          muxy.dialog
            .confirm({ title: a.label, message: `${a.label}\n\n${prompt}`, buttons: [t("common.run"), t("common.cancel")], cancel: t("common.cancel") })
            .then((c) => c === t("common.run")),
      });
      if (res.cancelled) { restore(); return; }
      changed = true;
      // 실행 후 상태가 바뀌었으면 이슈 상태·드롭다운을 갱신하고 액션 목록을 새 상태 기준으로 다시 그린다.
      if (res.appliedState) {
        issue.state = { ...(issue.state || {}), id: res.appliedState.id, name: res.appliedState.name };
        const sel = $("state");
        if (sel && [...sel.options].some((o) => o.value === res.appliedState.id)) sel.value = res.appliedState.id;
        toast(t("issue.stateChanged"), `${issue.identifier} → ${res.appliedState.name}`);
      } else {
        toast(t("issue.actionStarted"), issue.identifier);
      }
      renderActions(); // 버튼이 새로 생성되므로 restore 불필요
    } catch (e) {
      showErr(e.message);
      restore();
    } finally {
      actionRunning = false;
    }
  }

  // 기본 정보(API Key + 에이전트) 없으면 "액션 편집" 버튼도 숨김.
  if (!config.api_token || !config.agent_command) {
    const eb = $("edit-actions");
    if (eb) eb.style.display = "none";
  }
  renderActions();

  // 상태 드롭다운 채우기
  fetchTeamStates(config.api_token, issue.team.id)
    .then((states) => {
      const sel = $("state");
      sel.innerHTML = "";
      for (const s of states) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === issue.state?.id) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener("change", async () => {
        try {
          await updateIssueState(config.api_token, issue.id, sel.value);
          changed = true;
          toast(t("issue.stateChanged"), `${issue.identifier} → ${sel.options[sel.selectedIndex].text}`);
        } catch (e) {
          showErr(e.message);
        }
      });
    })
    .catch((e) => showErr(e.message));

  // ---- 속성 편집(담당자 / 중요도 / 프로젝트 / 라벨) ---------------------------
  // 값 변경은 모두 즉시 저장하고 목록 갱신 플래그(changed)를 세운다. API 키가 없으면
  // 조회/수정이 불가하므로 현재 값을 읽기 전용으로만 보여준다.
  const canEdit = !!config.api_token;

  // 중요도: 토큰 없이도 정적으로 채운다(현재 값은 issue.priority 에 있음).
  (function initPriority() {
    const sel = $("priority");
    const opts = [
      [0, t("priority.none")], [1, t("priority.urgent")], [2, t("priority.high")],
      [3, t("priority.normal")], [4, t("priority.low")],
    ];
    sel.innerHTML = "";
    for (const [v, label] of opts) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = label;
      if (v === (issue.priority ?? 0)) opt.selected = true;
      sel.append(opt);
    }
    sel.disabled = !canEdit;
    if (!canEdit) return;
    sel.addEventListener("change", async () => {
      try {
        await updateIssuePriority(config.api_token, issue.id, Number(sel.value));
        issue.priority = Number(sel.value);
        changed = true;
        toast(t("issue.saved"), issue.identifier);
      } catch (e) { showErr(e.message); }
    });
  })();

  // 담당자 드롭다운
  if (canEdit) {
    fetchTeamMembers(config.api_token, issue.team.id)
      .then((members) => {
        const sel = $("assignee");
        sel.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = t("issue.unassigned");
        sel.append(none);
        for (const m of members) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.displayName || m.name;
          if (m.id === issue.assignee?.id) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener("change", async () => {
          try {
            await updateIssueAssignee(config.api_token, issue.id, sel.value || null);
            issue.assignee = sel.value ? { id: sel.value, displayName: sel.options[sel.selectedIndex].text } : null;
            changed = true;
            toast(t("issue.saved"), issue.identifier);
          } catch (e) { showErr(e.message); }
        });
      })
      .catch((e) => { showErr(e.message); });
  } else {
    $("assignee").innerHTML = `<option>${escapeHtml(issue.assignee?.displayName || issue.assignee?.name || t("issue.unassigned"))}</option>`;
    $("assignee").disabled = true;
  }

  // 프로젝트 드롭다운
  if (canEdit) {
    fetchTeamProjects(config.api_token, issue.team.id)
      .then((projects) => {
        const sel = $("project");
        sel.innerHTML = "";
        const none = document.createElement("option");
        none.value = "";
        none.textContent = t("issue.noProject");
        sel.append(none);
        // 현재 프로젝트가 목록에 없으면(상태/권한 등) 맨 앞에 보강해 선택을 유지한다.
        let list = projects;
        if (issue.project?.id && !list.some((p) => p.id === issue.project.id)) {
          list = [{ id: issue.project.id, name: issue.project.name }, ...list];
        }
        for (const p of list) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name;
          if (p.id === issue.project?.id) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener("change", async () => {
          try {
            await updateIssueProject(config.api_token, issue.id, sel.value || null);
            issue.project = sel.value ? { id: sel.value, name: sel.options[sel.selectedIndex].text } : null;
            changed = true;
            toast(t("issue.saved"), issue.identifier);
          } catch (e) { showErr(e.message); }
        });
      })
      .catch((e) => { showErr(e.message); });
  } else {
    $("project").innerHTML = `<option>${escapeHtml(issue.project?.name || t("issue.noProject"))}</option>`;
    $("project").disabled = true;
  }

  // 라벨: 팀 전체 라벨을 토글 칩으로 보여주고, 켜진 칩 집합을 이슈 라벨로 저장한다.
  // 팀 라벨 목록(teamLabels)과 현재 이슈 라벨(issueLabelIds, loadDetail 에서 채움)이
  // 모두 준비돼야 렌더한다.
  let teamLabels = null;
  let issueLabelIds = null;
  let labelSaving = false;
  function renderLabels() {
    const box = $("labels");
    if (!canEdit) {
      box.classList.remove("muted");
      const names = (issue.labels || []).map((l) => l.name);
      box.textContent = names.length ? names.join(", ") : t("issue.noLabels");
      return;
    }
    if (!teamLabels || !issueLabelIds) return;
    box.classList.remove("muted");
    box.innerHTML = "";
    if (!teamLabels.length) { box.textContent = t("issue.noLabels"); return; }
    for (const l of teamLabels) {
      const chip = h(`<button class="label-chip" type="button"></button>`);
      chip.classList.toggle("on", issueLabelIds.has(l.id));
      chip.style.setProperty("--label-color", l.color || "#8a8f98");
      chip.textContent = l.name;
      chip.addEventListener("click", () => toggleLabel(l.id, chip));
      box.append(chip);
    }
  }
  async function toggleLabel(id, chip) {
    if (labelSaving) return;
    labelSaving = true;
    const next = new Set(issueLabelIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    try {
      await updateIssueLabels(config.api_token, issue.id, [...next]);
      issueLabelIds = next;
      chip.classList.toggle("on", next.has(id));
      changed = true;
      toast(t("issue.saved"), issue.identifier);
    } catch (e) {
      showErr(e.message);
    } finally {
      labelSaving = false;
    }
  }
  if (canEdit) {
    fetchTeamLabels(config.api_token, issue.team.id)
      .then((labels) => { teamLabels = labels; renderLabels(); })
      .catch((e) => showErr(e.message));
  } else {
    renderLabels(); // 토큰 없으면 읽기 전용 표시(대개 라벨 없음)
  }

  // 삭제 버튼: 토큰 있을 때만. 확인 후 휴지통으로 이동하고 창을 닫는다.
  if (!canEdit) {
    $("delete").style.display = "none";
  } else {
    $("delete").addEventListener("click", async () => {
      const ok = await muxy.dialog
        .confirm({
          title: t("issue.delete"),
          message: t("issue.deleteConfirm", { id: issue.identifier }),
          buttons: [t("common.delete"), t("common.cancel")],
          cancel: t("common.cancel"),
        })
        .then((c) => c === t("common.delete"))
        .catch(() => false);
      if (!ok) return;
      try {
        await deleteIssue(config.api_token, issue.id);
        changed = true;
        toast(t("issue.deleted"), issue.identifier);
        if (!asTab) muxy.modal.submitWebview({ changed: true });
        else muxy.lifecycle.close();
      } catch (e) {
        showErr(e.message);
      }
    });
  }

  // 본문 + 코멘트 로드(마크다운 렌더링)
  function renderComments(list) {
    const box = $("comments");
    box.classList.remove("muted");
    box.innerHTML = "";
    if (!list.length) {
      box.append(h(`<div class="muted">${t("issue.noComments")}</div>`));
      return;
    }
    for (const c of list) {
      const who = escapeHtml(c.user?.displayName || c.user?.name || t("issue.unknownUser"));
      const when = escapeHtml(new Date(c.createdAt).toLocaleString());
      const item = h(`<div class="comment">
        <div class="comment-head"><span class="comment-who">${who}</span><span class="comment-when">${when}</span></div>
        <div class="md comment-body"></div>
      </div>`);
      item.querySelector(".comment-body").innerHTML = renderMarkdown(c.body);
      box.append(item);
    }
  }

  // 하위 이슈: 상태 점 + 식별자 + 제목. 클릭하면 그 이슈를 새 탭으로 연다(모달 폴백).
  function renderSubIssues(list) {
    const box = $("sub-issues");
    box.classList.remove("muted");
    box.innerHTML = "";
    if (!list.length) {
      box.append(h(`<div class="muted">${t("issue.noSubIssues")}</div>`));
      return;
    }
    for (const c of list) {
      const row = h(`<button class="sub-issue" type="button"></button>`);
      const dot = h(`<span class="sub-dot"></span>`);
      dot.style.background = c.state?.color || "#8a8f98";
      const id = h(`<span class="sub-id"></span>`);
      id.textContent = c.identifier;
      const title = h(`<span class="sub-title"></span>`);
      title.textContent = c.title;
      row.append(dot, id, title);
      row.addEventListener("click", () => openChildIssue(c));
      box.append(row);
    }
  }

  // 하위 이슈 열기: 패널의 openIssue 와 동일하게 탭 웹뷰로 열고, 구버전에서는 URL 폴백.
  async function openChildIssue(child) {
    try {
      await muxy.tabs.open({
        kind: "extensionWebView",
        // KNK-89: singleton 으로 열어 이미 떠 있는 이슈 탭을 재사용한다(하위 이슈 클릭마다
        // 새 탭이 쌓이지 않게). 재사용되면 이 탭의 onDataChange 로 child 데이터가 들어온다.
        extension: { id: "linear", tabType: "issue", singleton: true, data: { issue: child, config, mode: "tab" } },
      });
    } catch {
      await openIssueUrl(child.url); // 탭 웹뷰 미지원 구버전 → 외부에서 열기
    }
  }

  // 하위 이슈 추가: 부모 정보를 넘겨 생성 모달을 연다. 생성되면 목록을 다시 로드.
  // API 키가 없으면 생성이 불가하므로 버튼을 숨긴다.
  if (!canEdit) {
    $("add-sub").style.display = "none";
  } else {
    $("add-sub").addEventListener("click", async () => {
      const r = await muxy.modal.openWebview({
        entry: "modals/create.html",
        width: 460,
        height: 640,
        data: { parent: { id: issue.id, identifier: issue.identifier, teamKey: issue.team?.key } },
      });
      if (r?.created) {
        changed = true;
        toast(t("issue.subIssueAdded"), r.issue?.identifier || issue.identifier);
        loadDetail(); // 새 하위 이슈를 목록에 반영
      }
    });
  }

  let rawDescription = ""; // 본문 원문(마크다운) — 편집용
  function paintDesc() {
    const descEl = $("desc");
    descEl.classList.remove("muted");
    descEl.innerHTML = rawDescription
      ? renderMarkdown(rawDescription)
      : `<span class="muted">${t("issue.emptyBodyClick")}</span>`;
  }
  async function loadDetail() {
    try {
      const { issue: detail, comments, children } = await fetchIssueDetail(config.api_token, issue.id);
      rawDescription = detail?.description || "";
      paintDesc();
      renderComments(comments);
      renderSubIssues(children);
      // 현재 이슈 라벨을 반영(라벨 칩 렌더에 사용).
      issue.labels = detail?.labels?.nodes || [];
      issueLabelIds = new Set(issue.labels.map((l) => l.id));
      renderLabels();
    } catch (e) {
      $("desc").textContent = "";
      $("comments").textContent = "";
      $("sub-issues").textContent = "";
      showErr(e.message);
    }
  }
  loadDetail();

  // 본문: 노션처럼 클릭하면 바로 편집, 포커스 아웃 시 자동 저장.
  let descSaving = false;
  function startEditDesc() {
    const ta = $("desc-input");
    ta.value = rawDescription;
    ta.hidden = false;
    $("desc").hidden = true;
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function stopEditDesc() {
    $("desc-input").hidden = true;
    $("desc").hidden = false;
  }
  $("desc").addEventListener("click", startEditDesc);
  $("desc-input").addEventListener("input", () => autoGrow($("desc-input")));
  $("desc-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopEditDesc(); // 저장 없이 닫기
  });
  $("desc-input").addEventListener("blur", async () => {
    if (descSaving) return;
    const next = $("desc-input").value;
    if (next === rawDescription) { stopEditDesc(); return; }
    descSaving = true;
    try {
      await updateIssueDescription(config.api_token, issue.id, next);
      rawDescription = next;
      paintDesc();
      stopEditDesc();
      changed = true;
      toast(t("issue.bodySaved"), issue.identifier);
    } catch (e) {
      // 계정에 수정 권한이 없으면 여기로 온다. 편집 상태 유지.
      showErr(t("issue.bodySaveFail", { msg: e.message }));
    } finally {
      descSaving = false;
    }
  });

  // 액션 편집 모달 열기.
  // - 모달 컨텍스트: 저장됐으면 이슈 모달을 닫으며 changed 를 패널로 전달(목록 새로고침).
  // - 탭 컨텍스트: 닫을 모달이 없으므로(submitWebview 불가) 탭은 그대로 둔다. 바뀐 액션은
  //   탭을 다시 열면 반영되고, 패널 목록은 폴링으로 자동 갱신된다.
  $("edit-actions").addEventListener("click", async () => {
    const r = await muxy.modal.openWebview({ entry: "modals/actions.html", width: 560, height: 640 });
    if (r && r.saved) changed = true;
    if (!asTab) muxy.modal.submitWebview({ changed });
  });

  // Linear에서 열기: 내장 브라우저 대신 외부(앱 또는 기본 브라우저)에서 연다.
  $("open-web").addEventListener("click", async () => {
    try {
      await openIssueUrl(issue.url);
    } catch (e) {
      showErr(e.message);
    }
  });

  // 코멘트: 본문 편집처럼 깔끔한 인라인 필드. 내용에 맞춰 자동으로 늘어나고, 작성 중일
  // 때만(포커스 또는 내용 있음) "코멘트 추가" 버튼을 노출한다.
  const commentEl = $("comment");
  function syncCommentActions() {
    const active = document.activeElement === commentEl || commentEl.value.trim() !== "";
    $("comment-actions").hidden = !active;
  }
  commentEl.addEventListener("input", () => { autoGrow(commentEl); syncCommentActions(); });
  commentEl.addEventListener("focus", syncCommentActions);
  commentEl.addEventListener("blur", syncCommentActions);
  // Cmd/Ctrl+Enter 로 바로 등록(본문처럼 키보드로 마무리).
  commentEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("add-comment").click(); }
  });

  // 코멘트 추가
  $("add-comment").addEventListener("click", async () => {
    const body = commentEl.value.trim();
    if (!body) return;
    $("add-comment").disabled = true;
    try {
      await createComment(config.api_token, issue.id, body);
      commentEl.value = "";
      autoGrow(commentEl);
      syncCommentActions();
      changed = true;
      toast(t("issue.commentAdded"), issue.identifier);
      await loadDetail();
    } catch (e) {
      showErr(e.message);
    } finally {
      $("add-comment").disabled = false;
    }
  });

  $("cancel").addEventListener("click", () => {
    // 탭 컨텍스트: 탭을 닫는다(변경은 패널 폴링이 반영). 모달 컨텍스트: 변경 있으면
    // submitWebview 로 패널에 알리며 닫고, 없으면 그냥 닫는다.
    if (!asTab && changed) muxy.modal.submitWebview({ changed: true });
    else muxy.lifecycle.close();
  });
}

run(main);

// KNK-89: 싱글턴 이슈 탭 재사용. 패널이나 하위 이슈에서 다른 이슈를 열면 새 탭 대신
// 이미 떠 있는 이 탭으로 데이터가 들어온다. 새 이슈로 전체를 다시 렌더해 탭이 계속
// 쌓이지 않게 한다. (구버전 muxy 는 onDataChange 가 없으므로 옵셔널 체이닝으로 무시.)
if (asTab) {
  muxy.onDataChange?.((data) => {
    if (!data?.issue) return;
    issue = data.issue;
    config = data.config || config;
    setLang(config?.language);
    changed = false;
    window.scrollTo?.(0, 0);
    main().catch((e) => console.error("[linear] onDataChange 재렌더 실패:", e?.message || e));
  });
}
