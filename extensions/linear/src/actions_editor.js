// 상태별 액션 편집 모달. config.actions 를 편집해 저장한다.

import "./theme.css";
import "./modal.css";
import { run } from "./fatal.js";
import { loadConfig, saveConfig, CONFIG_DEFAULTS, effectiveToken } from "./config.js";
import { fetchAllStates } from "./linear.js";
import { readProjectConfig, writeProjectConfig } from "./project.js";
import { EMOJI, EMOJI_GROUPS, GROUP_LABELS } from "./emoji.js";
import { setLang, t } from "./i18n.js";

const muxy = window.muxy;
const app = document.getElementById("app");

let actions = []; // 편집 중인 액션 배열
let stateList = []; // 워크스페이스 상태 목록 [{name,type}]
let branchList = []; // 저장소 브랜치 목록(베이스 선택용)
let editorScope = "global"; // 현재 편집 스코프
let globalById = new Map(); // 글로벌 액션 id→액션(프로젝트 스코프에서 기본값 표시용)
const TYPE_KEYS = ["started", "unstarted", "backlog", "completed", "canceled"];
const runLabel = (r) => ({ worktree: t("run.worktree"), branch: t("run.branch"), current: t("run.current") }[r]);
// 커스텀 툴팁(WKWebView 는 native title 을 안 띄우므로 직접 구현).
function attachTip(node, text) {
  let tip = null;
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  const show = () => {
    hide();
    tip = document.createElement("div");
    tip.className = "tip-pop";
    tip.textContent = text;
    document.body.append(tip);
    const r = node.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + "px";
    tip.style.top = r.bottom + 6 + "px";
  };
  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("click", (e) => { e.preventDefault(); tip ? hide() : show(); });
}

// 노션식 이모지 피커 팝업. anchor 아래에 검색+그리드를 띄우고, 고르면 onPick(emoji).
function openEmojiPicker(anchor, onPick) {
  document.querySelectorAll(".emoji-pop").forEach((n) => n.remove());
  const pop = el("div", { className: "emoji-pop" });
  const search = el("input", { type: "text", className: "emoji-search", placeholder: t("ae.emojiSearch") });
  const remove = el("button", { type: "button", className: "mini" }, t("ae.remove"));
  remove.addEventListener("click", () => { onPick(""); pop.remove(); });
  const grid = el("div", { className: "emoji-grid" });

  // 이모지 한 칸(버튼) 생성
  function cell(e) {
    const b = el("button", { type: "button", className: "emoji-cell" }, e.c);
    b.addEventListener("click", () => { onPick(e.c); pop.remove(); });
    return b;
  }
  // 카테고리 헤더(그리드 한 줄 전체 차지)
  function header(text) {
    return el("div", { className: "emoji-cat" }, text);
  }

  function renderGrid(q) {
    grid.innerHTML = "";
    const ql = q.trim().toLowerCase();
    if (ql) {
      // 검색 중에는 노션처럼 헤더 없이 평면 결과만.
      const list = EMOJI.filter((e) => e.c === ql || e.k.includes(ql));
      if (!list.length) { grid.append(el("div", { className: "muted", style: "grid-column:1/-1;padding:8px" }, t("common.noResult"))); return; }
      for (const e of list) grid.append(cell(e));
      return;
    }
    // 검색어가 없으면 카테고리별로 헤더 + 이모지를 렌더(그리드가 자체 스크롤됨).
    for (const g of EMOJI_GROUPS) {
      grid.append(header(GROUP_LABELS[g] || g));
      for (const e of EMOJI) if (e.g === g) grid.append(cell(e));
    }
  }
  search.addEventListener("input", () => renderGrid(search.value));
  renderGrid("");

  pop.append(el("div", { className: "emoji-pop-head" }, [search, remove]), grid);
  document.body.append(pop);

  // 위치: anchor 바로 아래(화면 밖으로 나가지 않게 클램프)
  const r = anchor.getBoundingClientRect();
  const w = 280;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top = r.bottom + 4 + "px";
  search.focus();

  // 바깥 클릭 / Esc 로 닫기
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) {
        pop.remove();
        document.removeEventListener("mousedown", onDoc);
      }
    };
    document.addEventListener("mousedown", onDoc);
  }, 0);
  pop.addEventListener("keydown", (ev) => { if (ev.key === "Escape") pop.remove(); });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// 새 액션 기본 골격
function blankAction() {
  return { id: `a${Date.now()}`, label: t("ae.newAction"), icon: "", appliesTo: [], run: "current", base: "", prompt: "", toState: "", confirm: false, mode: "", model: "" };
}

// "표시할 상태" 컨트롤: 단일 select(모든 상태 / 특정 상태). 상태를 못 불러오면 텍스트 폴백.
function appliesControl(action) {
  const current = (action.appliesTo || [])[0] || "";
  if (!stateList.length) {
    const input = el("input", { type: "text", value: current, placeholder: t("ae.appliesToPh") });
    input.addEventListener("input", () => {
      action.appliesTo = input.value.trim() ? [input.value.trim()] : [];
    });
    return input;
  }
  const sel = el("select");
  sel.append(el("option", { value: "" }, t("ae.allStates")));
  const known = stateList.some((s) => s.name === current);
  if (current && !known) {
    const o = el("option", { value: current }, t("ae.customInput", { v: current }));
    o.selected = true;
    sel.append(o);
  }
  for (const s of stateList) {
    const o = el("option", { value: s.name }, s.name);
    if (current === s.name) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => {
    action.appliesTo = sel.value ? [sel.value] : [];
  });
  return sel;
}

// "실행 후 상태 변경" 컨트롤: "표시할 상태"와 동일한 상태 목록 + "변경 안 함".
function toStateControl(action) {
  // 타입 키워드(started 등)로 저장된 값은 실제 상태 이름으로 변환해 목록을 일관되게.
  let cur = action.toState || "";
  if (cur && TYPE_KEYS.includes(cur)) {
    const match = stateList.find((s) => s.type === cur);
    if (match) { cur = match.name; action.toState = cur; }
  }
  if (!stateList.length) {
    const input = el("input", { type: "text", value: cur, placeholder: t("ae.toStatePh") });
    input.addEventListener("input", () => { action.toState = input.value; });
    return input;
  }
  const sel = el("select");
  sel.append(el("option", { value: "" }, t("ae.noChange")));
  const known = stateList.some((s) => s.name === cur);
  if (cur && !known) {
    const o = el("option", { value: cur }, t("ae.customInput", { v: cur }));
    o.selected = true;
    sel.append(o);
  }
  for (const s of stateList) {
    const o = el("option", { value: s.name }, s.name);
    if (cur === s.name) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener("change", () => { action.toState = sel.value; });
  return sel;
}

// "베이스 브랜치" 컨트롤: 기본/현재 브랜치/실제 브랜치 목록(없으면 텍스트 폴백).
function baseControl(action) {
  const cur = action.base || "";
  if (!branchList.length) {
    const input = el("input", { type: "text", value: cur, placeholder: t("ae.baseEmptyPh") });
    input.addEventListener("input", () => { action.base = input.value; });
    return input;
  }
  const sel = el("select");
  sel.append(el("option", { value: "" }, t("ae.defaultBase")));
  sel.append(el("option", { value: "@current" }, t("ae.currentBranchHere")));
  const isSpecial = cur === "" || cur === "@current";
  if (cur && !isSpecial && !branchList.includes(cur)) {
    const o = el("option", { value: cur }, t("ae.customInput", { v: cur }));
    o.selected = true;
    sel.append(o);
  }
  const g = el("optgroup", { label: t("ae.branch") });
  for (const b of branchList) {
    const o = el("option", { value: b }, b);
    if (cur === b) o.selected = true;
    g.append(o);
  }
  sel.append(g);
  if (cur === "@current") sel.value = "@current";
  else if (cur === "") sel.value = "";
  sel.addEventListener("change", () => { action.base = sel.value; });
  return sel;
}

// 입력창 커서 위치에 텍스트 삽입.
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event("input"));
  input.focus();
}

// 플레이스홀더: 토큰과 설명 키. 설명은 표시 시 t() 로 해석.
const PLACEHOLDERS = [
  { token: "{identifier}", dKey: "ae.phIssueNo" },
  { token: "{title}", dKey: "ae.phTitle" },
  { token: "{branch}", dKey: "ae.phBranch" },
  { token: "{url}", dKey: "ae.phUrl" },
  { token: "{description}", dKey: "ae.phDescription" },
];

// 바로 쓸 수 있는 범용 프롬프트 템플릿(라벨·본문 모두 i18n 키). 표시 시 t() 로 해석.
const PROMPT_PRESETS = [
  { labelKey: "ae.tplStartLabel", tplKey: "ae.tplStart" },
  { labelKey: "ae.tplFinishLabel", tplKey: "ae.tplFinish" },
  { labelKey: "ae.tplPrLabel", tplKey: "ae.tplPr" },
  { labelKey: "ae.tplReviewLabel", tplKey: "ae.tplReview" },
  { labelKey: "ae.tplBugLabel", tplKey: "ae.tplBug" },
  { labelKey: "ae.tplTestLabel", tplKey: "ae.tplTest" },
  { labelKey: "ae.tplRefactorLabel", tplKey: "ae.tplRefactor" },
  { labelKey: "ae.tplDocLabel", tplKey: "ae.tplDoc" },
];

// ✨ 프롬프트 만들기 팝업: 가이드 + 플레이스홀더 삽입 + 템플릿 선택.
function openPromptBuilder(anchor, promptEl) {
  document.querySelectorAll(".prompt-pop").forEach((n) => n.remove());
  const pop = el("div", { className: "prompt-pop" });

  pop.append(el("div", { className: "pp-guide" }, t("ae.pbGuide")));

  pop.append(el("div", { className: "pp-sub" }, t("ae.pbPlaceholders")));
  const chips = el("div", { className: "pp-chips" });
  for (const p of PLACEHOLDERS) {
    const c = el("button", { type: "button", className: "pp-chip" }, p.token);
    attachTip(c, t(p.dKey));
    c.addEventListener("click", () => insertAtCursor(promptEl, p.token));
    chips.append(c);
  }
  pop.append(chips);

  pop.append(el("div", { className: "pp-sub" }, t("ae.pbTemplates")));
  const list = el("div", { className: "pp-presets" });
  for (const pr of PROMPT_PRESETS) {
    const tpl = t(pr.tplKey);
    const b = el("button", { type: "button", className: "pp-preset" });
    b.append(el("div", { className: "pp-preset-label" }, t(pr.labelKey)));
    b.append(el("div", { className: "pp-preset-tpl" }, tpl.replace(/\n/g, " ⏎ ")));
    b.addEventListener("click", () => {
      promptEl.value = tpl;
      promptEl.dispatchEvent(new Event("input"));
      pop.remove();
      promptEl.focus();
    });
    list.append(b);
  }
  pop.append(list);

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = 340;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
  pop.style.top = r.bottom + 4 + "px";
  setTimeout(() => {
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) {
        pop.remove();
        document.removeEventListener("mousedown", onDoc);
      }
    };
    document.addEventListener("mousedown", onDoc);
  }, 0);
}

// 액션 하나의 편집 카드
function actionCard(action, index) {
  const card = el("div", { className: "act-card" });
  card.dataset.idx = index; // 저장 시 필수값 검증에서 이 카드의 입력을 찾기 위한 인덱스
  // 프로젝트 스코프면 같은 id의 글로벌 액션을 기본값 참고로.
  const g = editorScope === "project" ? globalById.get(action.id) : null;

  const head = el("div", { className: "row", style: "margin-bottom:8px" }, [
    el("strong", {}, `#${index + 1}`),
    el("span", { className: "spacer" }),
    (() => {
      const del = el("button", { className: "mini" }, t("common.delete"));
      del.addEventListener("click", () => { actions.splice(index, 1); renderList(); });
      return del;
    })(),
  ]);
  card.append(head);

  // 프로젝트 스코프: 이 액션의 글로벌 기본값 요약을 보여준다.
  if (g) {
    const summary = t("ae.globalSummary", {
      applies: g.appliesTo?.length ? g.appliesTo.join(", ") : t("ae.allStates"),
      run: runLabel(g.run) ?? g.run,
      base: g.base || t("ae.default"),
      prompt: g.prompt || t("ae.none"),
      toState: g.toState || t("ae.noChange"),
    });
    card.append(el("div", { className: "act-defaults" }, summary));
  }

  function field(labelText, control, hint) {
    const f = el("div", { className: "field" });
    const lab = el("span", { className: "label" }, labelText);
    if (hint) {
      // 라벨 오른쪽에 ? 도움말 아이콘 — 호버/클릭하면 설명(커스텀 툴팁).
      const help = el("span", { className: "help" }, "?");
      attachTip(help, hint);
      lab.append(help);
    }
    f.append(lab, control);
    return f;
  }

  // 아이콘(이모지) + 이름 — 노션식
  const iconBtn = el("button", { type: "button", className: "icon-pick", title: t("ae.pickIcon") }, action.icon || "＋");
  iconBtn.addEventListener("click", () =>
    openEmojiPicker(iconBtn, (emoji) => {
      action.icon = emoji;
      iconBtn.textContent = emoji || "＋";
      iconBtn.classList.toggle("empty", !emoji);
    }),
  );
  if (!action.icon) iconBtn.classList.add("empty");

  const label = el("input", { type: "text", value: action.label, placeholder: g ? g.label : t("ae.newAction") });
  label.dataset.req = "label"; // 필수값 검증 대상
  label.addEventListener("input", () => { action.label = label.value; label.classList.remove("invalid"); });

  const row = el("div", { className: "icon-label-row" }, [iconBtn, label]);
  card.append(field(t("ae.buttonName"), row, t("ae.buttonNameHelp")));

  // appliesTo — 상태 체크박스 목록(상태를 못 불러오면 텍스트 입력으로 폴백)
  card.append(field(t("ae.appliesTo"), appliesControl(action), t("ae.appliesToHelp")));

  // run
  const run = el("select");
  for (const [v, txt] of [["worktree", t("ae.runWorktree")], ["branch", t("ae.runBranch")], ["current", t("ae.runCurrent")]]) {
    const o = el("option", { value: v }, txt);
    if (action.run === v) o.selected = true;
    run.append(o);
  }
  run.addEventListener("change", () => { action.run = run.value; });
  card.append(field(t("ae.runMode"), run));

  // mode — Claude 권한 모드(claude 에이전트에서만 의미 있음). ""=기본.
  const mode = el("select");
  for (const [v, txt] of [["", t("ae.modeDefault")], ["plan", t("ae.modePlan")], ["acceptEdits", t("ae.modeAcceptEdits")], ["bypassPermissions", t("ae.modeBypass")]]) {
    const o = el("option", { value: v }, txt);
    if ((action.mode || "") === v) o.selected = true;
    mode.append(o);
  }
  mode.addEventListener("change", () => { action.mode = mode.value; });
  card.append(field(t("ae.agentMode"), mode, t("ae.agentModeHelp")));

  // model — Claude 모델. ""=기본.
  const model = el("select");
  for (const [v, txt] of [["", t("ae.modelDefault")], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]]) {
    const o = el("option", { value: v }, txt);
    if ((action.model || "") === v) o.selected = true;
    model.append(o);
  }
  model.addEventListener("change", () => { action.model = model.value; });
  card.append(field(t("ae.agentModel"), model, t("ae.agentModelHelp")));

  // base
  card.append(field(t("issue.baseBranch"), baseControl(action), t("ae.baseHelp")));

  // prompt + ✨ 프롬프트 만들기
  const prompt = el("textarea", { placeholder: g ? (g.prompt || t("ae.none")) : t("ae.promptPh") });
  prompt.value = action.prompt || "";
  prompt.dataset.req = "prompt"; // 필수값 검증 대상
  prompt.addEventListener("input", () => { action.prompt = prompt.value; prompt.classList.remove("invalid"); });
  const promptField = el("div", { className: "field" });
  const phead = el("div", { className: "row", style: "margin-bottom:4px" });
  const plab = el("span", { className: "label", style: "margin:0" }, t("ae.prompt"));
  const phelp = el("span", { className: "help" }, "?");
  attachTip(phelp, t("ae.promptHelp"));
  plab.append(phelp);
  const mkBtn = el("button", { type: "button", className: "mini" }, t("ae.buildPrompt"));
  mkBtn.addEventListener("click", () => openPromptBuilder(mkBtn, prompt));
  phead.append(plab, el("span", { className: "spacer" }), mkBtn);
  promptField.append(phead, prompt);
  card.append(promptField);

  // toState — 상태 드롭다운(상태를 못 불러오면 텍스트 입력으로 폴백)
  card.append(field(t("ae.toState"), toStateControl(action), t("ae.toStateHelp")));

  // confirm
  const confirmWrap = el("label", { className: "checkbox field" });
  const confirmBox = el("input", { type: "checkbox" });
  confirmBox.checked = !!action.confirm;
  confirmBox.addEventListener("change", () => { action.confirm = confirmBox.checked; });
  confirmWrap.append(confirmBox, document.createTextNode(t("ae.confirm")));
  card.append(confirmWrap);

  return card;
}

function renderList() {
  const listEl = document.getElementById("act-list");
  listEl.innerHTML = "";
  actions.forEach((a, i) => listEl.append(actionCard(a, i)));
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

async function main() {
  const config = await loadConfig();
  setLang(config.language);
  const projectCfg = await readProjectConfig(); // .linear.json 또는 null
  const token = effectiveToken(config, projectCfg); // 프로젝트 전용 키 우선

  // 기본 정보(API Key + 에이전트)가 없으면 액션 등록 자체를 막는다.
  if (!token || !config.agent_command) {
    const missing = [];
    if (!token) missing.push(t("ae.needSetupKey"));
    if (!config.agent_command) missing.push(t("ae.needSetupAgent"));
    app.innerHTML = `
      <h2 class="m-title">${t("ae.title")}</h2>
      <p class="error">${t("ae.needSetup", { missing: missing.join(t("ae.needSetupJoin")) })}</p>
      <p class="hint">${t("ae.reopenHint")}</p>
      <div class="actions"><button id="close" class="primary">${t("common.close")}</button></div>`;
    document.getElementById("close").addEventListener("click", () => muxy.lifecycle.close());
    return;
  }

  try {
    stateList = await fetchAllStates(token);
  } catch {
    stateList = [];
  }
  // 베이스 브랜치 후보(로컬 + 원격)
  try {
    const [loc, rem] = await Promise.all([
      window.muxy.git.branches().catch(() => []),
      window.muxy.git.remoteBranches().catch(() => []),
    ]);
    branchList = [...new Set([...loc, ...rem.map((b) => b.replace(/^origin\//, ""))])];
  } catch {
    branchList = [];
  }

  const globalActions = Array.isArray(config.actions) ? config.actions : [];
  globalById = new Map(globalActions.map((a) => [a.id, a]));
  const hasProject = !!projectCfg; // .linear.json 로 연결된 프로젝트가 있는가
  const projectName = projectCfg?.projectName || projectCfg?.teamKey || t("scope.project");
  // 프로젝트가 자체 액션을 가지고 있으면 프로젝트 스코프로 시작.
  let scope = projectCfg?.actions?.length ? "project" : "global";

  app.innerHTML = `
    <h2 class="m-title">${t("ae.titleEdit")}</h2>
    <div class="seg" id="scope" style="margin:6px 0 4px">
      <button class="seg-btn" data-scope="global">${t("scope.global")}</button>
      <button class="seg-btn" data-scope="project" ${hasProject ? "" : `disabled title='${t("ae.noProjectLinked")}'`}>${t("scope.project")}</button>
    </div>
    <div id="scope-banner" class="scope-banner"></div>
    <div id="act-list"></div>
    <div class="row" style="margin:10px 0;flex-wrap:wrap">
      <button id="add">${t("ae.addAction")}</button>
      <select id="import-global" style="width:auto;display:none"><option value="">${t("ae.overrideGlobal")}</option></select>
      <span class="spacer"></span>
      <button id="revert" class="mini" hidden>${t("ae.revertGlobal")}</button>
      <button id="reset" class="mini">${t("ae.restoreDefaults")}</button>
    </div>
    <p id="err" class="error" hidden></p>
    <div class="actions">
      <button id="cancel">${t("common.cancel")}</button>
      <button id="save" class="primary">${t("common.save")}</button>
    </div>
  `;

  // 스코프에 맞는 액션을 편집 버퍼로 로드.
  function loadScope() {
    editorScope = scope;
    const overriding = !!projectCfg?.actions?.length;
    if (scope === "project") {
      // 프로젝트 전용 액션만(없으면 빈 목록). 글로벌 액션은 여기 표시하지 않는다.
      actions = clone(projectCfg?.actions || []);
    } else {
      actions = clone(globalActions);
    }
    // 세그먼트 활성 표시
    for (const b of document.querySelectorAll("#scope .seg-btn")) {
      b.classList.toggle("is-active", b.dataset.scope === scope);
    }
    // 스코프 배너
    const banner = document.getElementById("scope-banner");
    if (scope === "project") {
      banner.className = "scope-banner project";
      banner.textContent = t("ae.bannerProject", { name: projectName });
    } else {
      banner.className = "scope-banner global";
      banner.textContent = t("ae.bannerGlobal");
    }
    document.getElementById("revert").hidden = scope !== "project" || !overriding;
    document.getElementById("import-global").style.display = scope === "project" ? "" : "none";
    renderList();
  }

  loadScope();

  document.getElementById("scope").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn || btn.disabled) return;
    scope = btn.dataset.scope;
    loadScope();
  });

  document.getElementById("add").addEventListener("click", () => { actions.push(blankAction()); renderList(); });
  document.getElementById("reset").addEventListener("click", () => {
    // 글로벌: 내장 기본값 / 프로젝트: 비움(글로벌만 적용).
    actions = clone(scope === "project" ? [] : CONFIG_DEFAULTS.actions);
    renderList();
  });

  // "글로벌 액션 재정의" 선택 목록(프로젝트 스코프에서 특정 글로벌 액션을 복사해 재정의).
  const importSel = document.getElementById("import-global");
  for (const a of globalActions) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = `${a.icon ? a.icon + " " : ""}${a.label}`;
    importSel.append(o);
  }
  importSel.addEventListener("change", () => {
    const id = importSel.value;
    importSel.value = "";
    if (!id) return;
    if (actions.some((a) => a.id === id)) { muxy.toast?.({ title: t("ae.alreadyExistsTitle"), body: t("ae.alreadyExistsBody") }); return; }
    const src = globalById.get(id);
    if (src) { actions.push(clone(src)); renderList(); }
  });
  document.getElementById("revert").addEventListener("click", async () => {
    // 프로젝트 재정의 제거 → 글로벌 사용.
    const rest = { ...projectCfg };
    delete rest.actions;
    await writeProjectConfig(rest);
    muxy.toast?.({ title: t("ae.revertedGlobal"), body: projectName });
    muxy.modal.submitWebview({ saved: true });
  });
  // 필수값 검증: 버튼 이름·프롬프트가 비면 해당 input에 빨간 테두리(.invalid)를 칠하고 저장을 막는다.
  function validateRequired() {
    const errEl = document.getElementById("err");
    let firstBad = null;
    let badCount = 0;
    actions.forEach((a, i) => {
      const card = document.querySelector(`#act-list .act-card[data-idx="${i}"]`);
      if (!card) return;
      const checks = [
        [card.querySelector('[data-req="label"]'), !a.label || !a.label.trim()],
        [card.querySelector('[data-req="prompt"]'), !a.prompt || !a.prompt.trim()],
      ];
      for (const [inp, empty] of checks) {
        if (!inp) continue;
        inp.classList.toggle("invalid", empty);
        if (empty) { badCount++; firstBad = firstBad || inp; }
      }
    });
    if (badCount) {
      errEl.hidden = false;
      errEl.textContent = t("ae.requiredErr");
      firstBad?.scrollIntoView({ block: "center" });
      firstBad?.focus();
    } else {
      errEl.hidden = true;
    }
    return badCount === 0;
  }

  document.getElementById("cancel").addEventListener("click", () => muxy.lifecycle.close());
  document.getElementById("save").addEventListener("click", async () => {
    if (!validateRequired()) return;
    if (scope === "project") {
      await writeProjectConfig({ ...projectCfg, actions });
      muxy.toast?.({ title: t("ae.savedProject"), body: t("ae.savedProjectBody", { name: projectName, n: actions.length }) });
    } else {
      await saveConfig({ actions });
      muxy.toast?.({ title: t("ae.savedGlobal"), body: t("ae.savedGlobalBody", { n: actions.length }) });
    }
    muxy.modal.submitWebview({ saved: true });
  });
}

run(main);
