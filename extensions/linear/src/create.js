// 새 이슈 생성 모달. 팔레트 명령(openModal) 또는 패널 "+"(openWebview)로 열린다.

import "./theme.css";
import "./modal.css";
import { run } from "./fatal.js";
import { loadConfig, effectiveToken } from "./config.js";
import { readProjectConfig } from "./project.js";
import { resolveTeam, createIssue } from "./linear.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const app = document.getElementById("app");

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
  const defaultTeam = projectCfg?.teamKey || config.team_key;

  app.innerHTML = `
    <h2 class="m-title">${t("create.title")}</h2>
    <div class="field">
      <span class="label">${t("create.teamKey")}</span>
      <input type="text" id="team" value="${escapeHtml(defaultTeam)}" placeholder="${t("create.teamKeyPh")}" />
    </div>
    <div class="field">
      <span class="label">${t("create.titleLabel")}</span>
      <input type="text" id="title" autofocus />
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

  $("title").focus();

  $("cancel").addEventListener("click", () => muxy.lifecycle.close());

  $("create").addEventListener("click", async () => {
    const title = $("title").value.trim();
    if (!title) return showErr(t("create.titleRequired"));
    showErr("");
    $("create").disabled = true;
    try {
      const team = await resolveTeam(token, $("team").value.trim());
      const created = await createIssue(token, {
        teamId: team.id,
        title,
        description: $("desc").value.trim(),
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
