// 새 이슈 생성 모달. 팔레트 명령(openModal) 또는 패널 "+"(openWebview)로 열린다.
// 이슈 상세(편집) 화면과 같은 속성 UI(담당자·중요도·프로젝트·마일스톤·라벨)를 제공하고,
// 팀 템플릿을 골라 폼을 자동으로 채울 수 있다.

import "./theme.css";
import "./modal.css";
import { run } from "./fatal.js";
import { loadConfig, effectiveToken } from "./config.js";
import { readProjectConfig } from "./project.js";
import {
  resolveTeam, createIssue,
  fetchTeamMembers, fetchTeamProjects, fetchTeamLabels,
  fetchProjectMilestones, fetchTeamTemplates,
} from "./linear.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const app = document.getElementById("app");
// 이슈 상세에서 "하위 이슈 추가"로 열리면 부모 정보가 넘어온다({ id, identifier, teamKey }).
// 이 경우 생성 시 parentId 를 지정해 하위 이슈로 만든다.
const parent = muxy.data?.parent || null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function h(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

async function main() {
  const config = await loadConfig();
  setLang(config.language);
  const projectCfg = await readProjectConfig();
  const token = effectiveToken(config, projectCfg); // 프로젝트 전용 키 우선
  if (!token) {
    app.innerHTML = `<p class="error">${t("create.needKey")}</p>
      <div class="actions"><button id="close">${t("common.close")}</button></div>`;
    document.getElementById("close").addEventListener("click", () => muxy.lifecycle.close());
    return;
  }
  // 부모가 있으면 부모의 팀을 우선한다(하위 이슈는 같은 팀에서 만드는 게 일반적).
  const defaultTeam = parent?.teamKey || projectCfg?.teamKey || config.team_key;

  app.innerHTML = `
    <h2 class="m-title">${parent ? t("create.subTitle") : t("create.title")}</h2>
    ${parent ? `<div class="issue-meta"><span class="chip">${t("create.parentOf", { id: escapeHtml(parent.identifier) })}</span></div>` : ""}

    <div class="props">
      <div class="field">
        <span class="label">${t("create.teamKey")}</span>
        <input type="text" id="team" value="${escapeHtml(defaultTeam)}" placeholder="${t("create.teamKeyPh")}" />
      </div>
      <div class="field">
        <span class="label">${t("create.template")}</span>
        <select id="template"><option value="">${t("create.noTemplate")}</option></select>
      </div>
    </div>

    <div class="field">
      <span class="label">${t("create.titleLabel")}</span>
      <input type="text" id="title" autofocus />
    </div>

    <div class="props">
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
      <div class="field">
        <span class="label">${t("create.milestone")}</span>
        <select id="milestone"><option value="">${t("create.noMilestone")}</option></select>
      </div>
    </div>

    <div class="field">
      <span class="label">${t("issue.labels")}</span>
      <div id="labels" class="label-chips muted">${t("common.loading")}</div>
    </div>

    <div class="field">
      <span class="label">${t("create.desc")}</span>
      <textarea id="desc" placeholder="${t("create.descPh")}"></textarea>
    </div>

    <p id="err" class="error" hidden></p>
    <div class="actions">
      <button id="cancel">${t("common.cancel")}</button>
      <button id="create" class="primary">${t("common.create")}</button>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const errEl = $("err");
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  // ---- 중요도: 정적으로 채운다(기본값 없음). ------------------------------------
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
      if (v === 0) opt.selected = true;
      sel.append(opt);
    }
  })();

  // ---- 라벨: 팀 라벨을 토글 칩으로. 켜진 집합을 생성 시 함께 등록한다. ----------
  let teamLabels = [];
  const selectedLabels = new Set();
  function renderLabels() {
    const box = $("labels");
    box.classList.remove("muted");
    box.innerHTML = "";
    if (!teamLabels.length) { box.textContent = t("issue.noLabels"); return; }
    for (const l of teamLabels) {
      const chip = h(`<button class="label-chip" type="button"></button>`);
      chip.classList.toggle("on", selectedLabels.has(l.id));
      chip.style.setProperty("--label-color", l.color || "#8a8f98");
      chip.textContent = l.name;
      chip.addEventListener("click", () => {
        if (selectedLabels.has(l.id)) selectedLabels.delete(l.id); else selectedLabels.add(l.id);
        chip.classList.toggle("on", selectedLabels.has(l.id));
      });
      box.append(chip);
    }
  }

  // 셀렉트 채우기 헬퍼: [{value,label}] + 맨 앞 "없음" 옵션.
  function fillSelect(sel, items, { noneLabel, selected = "" } = {}) {
    sel.innerHTML = "";
    if (noneLabel != null) {
      const none = document.createElement("option");
      none.value = "";
      none.textContent = noneLabel;
      sel.append(none);
    }
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = it.value;
      opt.textContent = it.label;
      if (it.value === selected) opt.selected = true;
      sel.append(opt);
    }
  }

  // ---- 마일스톤: 선택된 프로젝트에 종속. 프로젝트가 바뀌면 다시 로드한다. -------
  async function loadMilestones(projectId, selected = "") {
    const sel = $("milestone");
    if (!projectId) {
      fillSelect(sel, [], { noneLabel: t("create.noMilestone") });
      sel.disabled = true;
      return;
    }
    sel.disabled = true;
    fillSelect(sel, [], { noneLabel: t("common.loading") });
    try {
      const milestones = await fetchProjectMilestones(token, projectId);
      fillSelect(sel, milestones.map((m) => ({ value: m.id, label: m.name })), {
        noneLabel: t("create.noMilestone"), selected,
      });
      sel.disabled = false;
    } catch (e) {
      fillSelect(sel, [], { noneLabel: t("create.noMilestone") });
      sel.disabled = false;
      showErr(e.message);
    }
  }

  // ---- 팀 종속 데이터 로드(담당자·프로젝트·라벨·템플릿). 팀 키 변경 시 재실행. --
  let teamId = null;
  let templates = [];
  async function loadTeamData(teamKey) {
    // 로딩 표시
    $("assignee").innerHTML = `<option>${t("common.loading")}</option>`;
    $("project").innerHTML = `<option>${t("common.loading")}</option>`;
    $("labels").textContent = t("common.loading");
    $("labels").classList.add("muted");
    try {
      const team = await resolveTeam(token, teamKey);
      teamId = team.id;
      $("team").value = team.key; // 정규화된 키 반영

      const [members, projects, labels, tpls] = await Promise.all([
        fetchTeamMembers(token, teamId).catch(() => []),
        fetchTeamProjects(token, teamId).catch(() => []),
        fetchTeamLabels(token, teamId).catch(() => []),
        fetchTeamTemplates(token, teamId).catch(() => []),
      ]);

      fillSelect($("assignee"), members.map((m) => ({ value: m.id, label: m.displayName || m.name })), {
        noneLabel: t("issue.unassigned"),
      });
      fillSelect($("project"), projects.map((p) => ({ value: p.id, label: p.name })), {
        noneLabel: t("issue.noProject"),
      });
      await loadMilestones($("project").value);

      teamLabels = labels;
      // 존재하지 않는(이전 팀) 라벨 선택은 정리.
      const valid = new Set(labels.map((l) => l.id));
      for (const id of [...selectedLabels]) if (!valid.has(id)) selectedLabels.delete(id);
      renderLabels();

      templates = tpls;
      fillSelect($("template"), tpls.map((tp) => ({ value: tp.id, label: tp.name })), {
        noneLabel: t("create.noTemplate"),
      });
    } catch (e) {
      showErr(e.message);
      $("assignee").innerHTML = `<option>—</option>`;
      $("project").innerHTML = `<option>—</option>`;
      $("labels").textContent = t("issue.noLabels");
      $("labels").classList.remove("muted");
    }
  }

  // 프로젝트가 바뀌면 마일스톤을 다시 로드(리스너는 한 번만 등록).
  $("project").addEventListener("change", () => loadMilestones($("project").value));

  // 팀 키를 바꾸면(포커스 아웃) 종속 데이터를 다시 로드한다.
  let lastTeamKey = defaultTeam;
  $("team").addEventListener("change", () => {
    const key = $("team").value.trim();
    if (key === lastTeamKey) return;
    lastTeamKey = key;
    loadTeamData(key);
  });

  // ---- 템플릿 적용: templateData 로 폼을 채운다. -------------------------------
  $("template").addEventListener("change", () => {
    const tpl = templates.find((tp) => tp.id === $("template").value);
    if (!tpl) return;
    applyTemplate(tpl.templateData || {});
  });

  function applyTemplate(data) {
    // Linear templateData 는 이슈 기본값을 담고 있다. 존재/타입이 맞는 값만 반영한다.
    if (typeof data.title === "string" && !$("title").value.trim()) $("title").value = data.title;
    if (typeof data.description === "string" && !$("desc").value.trim()) $("desc").value = data.description;
    if (typeof data.priority === "number") {
      const sel = $("priority");
      if ([...sel.options].some((o) => o.value === String(data.priority))) sel.value = String(data.priority);
    }
    if (data.assigneeId) {
      const sel = $("assignee");
      if ([...sel.options].some((o) => o.value === data.assigneeId)) sel.value = data.assigneeId;
    }
    if (data.projectId) {
      const sel = $("project");
      if ([...sel.options].some((o) => o.value === data.projectId)) {
        sel.value = data.projectId;
        loadMilestones(sel.value, data.projectMilestoneId || "");
      }
    }
    const tplLabels = data.labelIds || data.labels;
    if (Array.isArray(tplLabels)) {
      for (const id of tplLabels) if (teamLabels.some((l) => l.id === id)) selectedLabels.add(id);
      renderLabels();
    }
  }

  // 초기 로드
  $("title").focus();
  loadTeamData(defaultTeam);

  $("cancel").addEventListener("click", () => muxy.lifecycle.close());

  $("create").addEventListener("click", async () => {
    const title = $("title").value.trim();
    if (!title) return showErr(t("create.titleRequired"));
    showErr("");
    $("create").disabled = true;
    try {
      // teamId 가 아직 준비 안 됐으면(로드 실패/지연) 팀 키로 재확인.
      if (!teamId) {
        const team = await resolveTeam(token, $("team").value.trim());
        teamId = team.id;
      }
      const created = await createIssue(token, {
        teamId,
        title,
        description: $("desc").value.trim(),
        assigneeId: $("assignee").value || undefined,
        priority: Number($("priority").value),
        projectId: $("project").value || undefined,
        projectMilestoneId: $("milestone").value || undefined,
        labelIds: [...selectedLabels],
        parentId: parent?.id || undefined,
      });
      muxy.toast?.({ title: t("create.created"), body: `${created.identifier}` });
      muxy.modal.submitWebview({ created: true, issue: created });
    } catch (e) {
      showErr(e.message);
      $("create").disabled = false;
    }
  });
}

run(main);
