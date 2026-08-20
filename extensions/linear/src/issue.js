// 이슈 상세 모달: 상태 변경 / 본문·코멘트 보기(마크다운) / 상태별 액션 실행.
// 열림 데이터: window.muxy.data = { issue, config }

import "./theme.css";
import "./modal.css";
import { run } from "./fatal.js";
import { fetchTeamStates, updateIssueState, createComment, fetchIssueDetail, updateIssueDescription } from "./linear.js";
import { renderMarkdown } from "./markdown.js";
import { listBaseBranchCandidates, defaultBranch } from "./git.js";
import { applicableActions, runAction } from "./actions.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const app = document.getElementById("app");
const { issue, config } = muxy.data || {};
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const runLabel = (r) => ({ worktree: t("run.worktree"), branch: t("run.branch"), current: t("run.current") }[r]);

async function main() {
  if (!issue) {
    app.textContent = t("issue.cannotLoad");
    return;
  }

  app.innerHTML = `
    <header class="m-head">
      <div class="m-id">${escapeHtml(issue.identifier)}</div>
      <button id="open-web" class="icon-btn" title="${t("issue.openInLinear")}">↗</button>
    </header>
    <h2 class="m-title">${escapeHtml(issue.title)}</h2>
    <div class="issue-meta">
      <span class="chip">👤 ${escapeHtml(issue.assignee?.displayName || issue.assignee?.name || t("issue.unassigned"))}</span>
      ${issue.project?.name ? `<span class="chip">📁 ${escapeHtml(issue.project.name)}</span>` : ""}
      ${issue.projectMilestone?.name ? `<span class="chip">◆ ${escapeHtml(issue.projectMilestone.name)}</span>` : ""}
    </div>

    <div class="field">
      <span class="label">${t("issue.state")}</span>
      <select id="state"><option>${t("common.loading")}</option></select>
    </div>

    <div class="field">
      <span class="label">${t("issue.body")} <span class="muted" style="font-weight:400;font-size:11px">${t("issue.clickToEdit")}</span></span>
      <div id="desc" class="md doc muted" title="${t("issue.clickToEditTitle")}">${t("common.loading")}</div>
      <textarea id="desc-input" hidden style="min-height:160px"></textarea>
    </div>

    <hr class="sep" />
    <h3 class="sec-title">${t("issue.comments")}</h3>
    <div id="comments" class="comments muted">${t("common.loading")}</div>
    <div class="field" style="margin-top:10px">
      <div class="row" style="margin-bottom:4px">
        <span class="label" style="margin:0">${t("issue.newComment")}</span>
        <span class="spacer"></span>
        <button id="preview-toggle" class="mini">${t("issue.preview")}</button>
      </div>
      <textarea id="comment" placeholder="${t("issue.commentPlaceholder")}"></textarea>
      <div id="comment-preview" class="md" hidden></div>
      <div class="row" style="margin-top:6px">
        <span class="spacer"></span>
        <button id="add-comment">${t("issue.addComment")}</button>
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
      btn.addEventListener("click", () => runModalAction(a));
      const meta = h(`<div class="hint"></div>`);
      meta.textContent = `${runLabel(a.run) ?? a.run}${a.toState ? ` · → ${a.toState}` : ""}`;
      item.append(btn, meta);
      box.append(item);
    }
  }

  async function runModalAction(action) {
    showErr("");
    try {
      const res = await runAction(action, issue, config, {
        branch: $("branch").value.trim(),
        base: $("base").value,
        confirmFn: (a, prompt) =>
          muxy.dialog
            .confirm({ title: a.label, message: `${a.label}\n\n${prompt}`, buttons: [t("common.run"), t("common.cancel")], cancel: t("common.cancel") })
            .then((c) => c === t("common.run")),
      });
      if (res.cancelled) return;
      changed = true;
      muxy.modal.submitWebview({ changed: true });
    } catch (e) {
      showErr(e.message);
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
      const { issue: detail, comments } = await fetchIssueDetail(config.api_token, issue.id);
      rawDescription = detail?.description || "";
      paintDesc();
      renderComments(comments);
    } catch (e) {
      $("desc").textContent = "";
      $("comments").textContent = "";
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
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function stopEditDesc() {
    $("desc-input").hidden = true;
    $("desc").hidden = false;
  }
  $("desc").addEventListener("click", startEditDesc);
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

  // 액션 편집 모달 열기 — 저장됐으면 목록 새로고침되도록 changed 전달.
  $("edit-actions").addEventListener("click", async () => {
    const r = await muxy.modal.openWebview({ entry: "modals/actions.html", width: 560, height: 640 });
    muxy.modal.submitWebview({ changed: changed || !!(r && r.saved) });
  });

  // 코멘트 작성 미리보기 토글
  let previewOn = false;
  $("preview-toggle").addEventListener("click", () => {
    previewOn = !previewOn;
    const pv = $("comment-preview");
    const ta = $("comment");
    if (previewOn) {
      pv.innerHTML = renderMarkdown(ta.value || t("issue.previewEmpty"));
      pv.hidden = false;
      ta.hidden = true;
      $("preview-toggle").textContent = t("common.edit");
    } else {
      pv.hidden = true;
      ta.hidden = false;
      $("preview-toggle").textContent = t("issue.preview");
    }
  });

  // Linear에서 열기(Muxy 내장 브라우저)
  $("open-web").addEventListener("click", () => {
    Promise.resolve(muxy.browser.open(issue.url)).catch((e) => showErr(e.message));
  });

  // 코멘트 추가
  $("add-comment").addEventListener("click", async () => {
    const body = $("comment").value.trim();
    if (!body) return;
    $("add-comment").disabled = true;
    try {
      await createComment(config.api_token, issue.id, body);
      $("comment").value = "";
      if (previewOn) $("preview-toggle").click();
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
    if (changed) muxy.modal.submitWebview({ changed: true });
    else muxy.lifecycle.close();
  });
}

run(main);
