// KNK-90: 마크다운 본문 입력 개선.
// 일반 <textarea> 에 노션식 "/" 슬래시 명령 메뉴와 위지위그 스타일 서식 툴바를 붙인다.
// - "/" 를 (줄 시작이나 공백 뒤에) 입력하면 제목1~3, 목록, 이미지 삽입 등 메뉴가 뜬다.
// - 텍스트를 선택하고 툴바 버튼을 누르면 즉시 해당 마크다운 서식으로 감싼다.
// 렌더러(marked)는 그대로 두고 "작성 경험"만 보강한다 → 결과물은 여전히 순수 마크다운.

import { t } from "./i18n.js";

// 삽입/감싸기의 공통 저수준 유틸 ------------------------------------------------

// 값·선택영역을 바꾸고 input 이벤트를 쏜다(호출측 autoGrow/저장 로직이 반응하도록).
function commit(ta, value, selStart, selEnd = selStart) {
  ta.value = value;
  ta.setSelectionRange(selStart, selEnd);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

// pos 가 속한 줄의 시작 인덱스.
function lineStartOf(value, pos) {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

// 현재 줄 맨 앞에 prefix("# ", "- " 등)를 넣는다. 슬래시로 부른 빈 줄이면 그대로 입력 대기.
function applyPrefix(ta, prefix) {
  const { value, selectionStart: s } = ta;
  const ls = lineStartOf(value, s);
  const next = value.slice(0, ls) + prefix + value.slice(ls);
  commit(ta, next, s + prefix.length);
}

// 선택 영역을 before/after 로 감싼다. 선택이 없으면 placeholder 를 넣고 그 부분을 선택.
function applyWrap(ta, before, after, placeholder) {
  const { value, selectionStart: s, selectionEnd: e } = ta;
  const inner = value.slice(s, e) || placeholder;
  const next = value.slice(0, s) + before + inner + after + value.slice(e);
  const from = s + before.length;
  commit(ta, next, from, from + inner.length);
}

// 블록(코드펜스·구분선 등)을 삽입한다. 앞에 내용이 있으면 줄바꿈으로 분리한다.
// sel 이 주어지면 삽입 텍스트 기준 상대 위치를 선택한다(플레이스홀더 편집용).
function applyBlock(ta, text, sel) {
  const { value, selectionStart: s, selectionEnd: e } = ta;
  const head = value.slice(0, s);
  const pad = head && !head.endsWith("\n") ? "\n" : "";
  const insert = pad + text;
  const next = head + insert + value.slice(e);
  const base = s + pad.length;
  if (sel) commit(ta, next, base + sel[0], base + sel[1]);
  else commit(ta, next, s + insert.length);
}

// 명령 목록: 슬래시 메뉴와 툴바가 함께 쓴다. icon 은 툴바 버튼 라벨.
// key 는 i18n 라벨 키, keys 는 검색 키워드(영문/한글 혼용 필터).
const COMMANDS = [
  { id: "h1", icon: "H1", key: "md.h1", keys: ["h1", "heading", "제목", "見出し", "标题"], run: (ta) => applyPrefix(ta, "# ") },
  { id: "h2", icon: "H2", key: "md.h2", keys: ["h2", "heading", "제목", "見出し", "标题"], run: (ta) => applyPrefix(ta, "## ") },
  { id: "h3", icon: "H3", key: "md.h3", keys: ["h3", "heading", "제목", "見出し", "标题"], run: (ta) => applyPrefix(ta, "### ") },
  { id: "bold", icon: "B", key: "md.bold", keys: ["bold", "굵게", "강조", "太字", "加粗"], run: (ta) => applyWrap(ta, "**", "**", t("md.phText")) },
  { id: "italic", icon: "I", key: "md.italic", keys: ["italic", "기울임", "이탤릭", "斜体"], run: (ta) => applyWrap(ta, "*", "*", t("md.phText")) },
  { id: "strike", icon: "S", key: "md.strike", keys: ["strike", "취소선", "打消", "删除线"], run: (ta) => applyWrap(ta, "~~", "~~", t("md.phText")) },
  { id: "ul", icon: "•", key: "md.bulletList", keys: ["list", "bullet", "목록", "リスト", "列表"], run: (ta) => applyPrefix(ta, "- ") },
  { id: "ol", icon: "1.", key: "md.numberedList", keys: ["number", "ordered", "번호", "番号", "有序"], run: (ta) => applyPrefix(ta, "1. ") },
  { id: "todo", icon: "☑", key: "md.todo", keys: ["todo", "task", "checkbox", "체크", "할일", "タスク", "待办"], run: (ta) => applyPrefix(ta, "- [ ] ") },
  { id: "quote", icon: "❝", key: "md.quote", keys: ["quote", "인용", "引用"], run: (ta) => applyPrefix(ta, "> ") },
  { id: "code", icon: "</>", key: "md.codeBlock", keys: ["code", "코드", "コード", "代码"], run: (ta) => applyBlock(ta, "```\n\n```", [4, 4]) },
  { id: "divider", icon: "―", key: "md.divider", keys: ["divider", "hr", "구분선", "区切", "分割"], run: (ta) => applyBlock(ta, "---\n") },
  {
    id: "link", icon: "🔗", key: "md.link", keys: ["link", "링크", "リンク", "链接"],
    run: (ta) => {
      const { value, selectionStart: s, selectionEnd: e } = ta;
      const label = value.slice(s, e) || t("md.phText");
      const url = t("md.phUrl");
      const text = `[${label}](${url})`;
      const from = s + 1 + label.length + 2; // "[label](" 다음 = url 시작
      commit(ta, value.slice(0, s) + text + value.slice(e), from, from + url.length);
    },
  },
  {
    id: "image", icon: "🖼", key: "md.image", keys: ["image", "img", "이미지", "사진", "画像", "图片"],
    run: (ta) => {
      const { value, selectionStart: s, selectionEnd: e } = ta;
      const alt = value.slice(s, e) || t("md.phImageAlt");
      const url = t("md.phUrl");
      const text = `![${alt}](${url})`;
      const from = s + 2 + alt.length + 2; // "![alt](" 다음 = url 시작
      commit(ta, value.slice(0, s) + text + value.slice(e), from, from + url.length);
    },
  },
];

// 슬래시 메뉴에 노출할 명령(툴바에는 전부, 메뉴엔 서식 위주로). 여기선 동일 집합 사용.
const MENU_COMMANDS = COMMANDS;

// textarea 커서의 화면 좌표를 구한다(미러 div 기법). 슬래시 메뉴를 커서 아래 띄우는 데 사용.
const MIRROR_PROPS = [
  "boxSizing", "width", "borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth",
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontFamily",
  "lineHeight", "letterSpacing", "textTransform", "wordSpacing", "textIndent", "whiteSpace",
];
function caretCoords(ta, pos) {
  const div = document.createElement("div");
  const cs = getComputedStyle(ta);
  for (const p of MIRROR_PROPS) div.style[p] = cs[p];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement("span");
  span.textContent = ta.value.slice(pos) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const top = span.offsetTop;
  const left = span.offsetLeft;
  const lh = parseInt(cs.lineHeight) || parseInt(cs.fontSize) * 1.4 || 18;
  document.body.removeChild(div);
  return { top, left, lineHeight: lh };
}

// 텍스트에어리어 하나를 마크다운 에디터로 강화한다.
export function attachMarkdownEditor(ta, { toolbar = true } = {}) {
  if (!ta || ta.dataset.mdEditor) return; // 중복 부착 방지
  ta.dataset.mdEditor = "1";

  // ── 서식 툴바(위지위그식 즉시 서식) ─────────────────────────────────────────
  let bar = null;
  if (toolbar) {
    bar = document.createElement("div");
    bar.className = "md-toolbar";
    bar.hidden = true; // 편집(포커스) 중에만 노출
    for (const c of COMMANDS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "md-tb-btn";
      b.dataset.cmd = c.id;
      b.textContent = c.icon;
      b.title = t(c.key);
      // mousedown 에서 포커스/선택이 풀리지 않게 막고(=blur 저장 방지) click 에서 적용.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { c.run(ta); closeMenu(); });
      bar.appendChild(b);
    }
    ta.parentNode.insertBefore(bar, ta);
  }

  // ── 슬래시 명령 메뉴 ────────────────────────────────────────────────────────
  const menu = document.createElement("div");
  menu.className = "md-slash-menu";
  menu.hidden = true;
  document.body.appendChild(menu);

  let open = false;
  let slashStart = -1;   // 트리거 "/" 의 인덱스
  let filtered = [];     // 현재 필터된 명령
  let active = 0;        // 하이라이트 인덱스

  function showBar() { if (bar) bar.hidden = false; }
  function hideBar() { if (bar) bar.hidden = true; }

  function closeMenu() {
    open = false;
    slashStart = -1;
    menu.hidden = true;
  }

  function renderMenu() {
    menu.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "md-slash-empty";
      empty.textContent = t("md.noResults");
      menu.appendChild(empty);
      return;
    }
    filtered.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "md-slash-item" + (i === active ? " active" : "");
      item.innerHTML = `<span class="md-slash-icon">${c.icon}</span><span class="md-slash-label"></span>`;
      item.querySelector(".md-slash-label").textContent = t(c.key);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      item.addEventListener("mousemove", () => { if (active !== i) { active = i; renderMenu(); } });
      menu.appendChild(item);
    });
  }

  function positionMenu() {
    const rect = ta.getBoundingClientRect();
    const { top, left, lineHeight } = caretCoords(ta, ta.selectionStart);
    let x = rect.left + left - ta.scrollLeft;
    let y = rect.top + top - ta.scrollTop + lineHeight + 4;
    menu.hidden = false; // 크기 측정을 위해 먼저 노출
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 200;
    // 화면 밖으로 나가면 보정.
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (x < 8) x = 8;
    if (y + mh > window.innerHeight - 8) y = rect.top + top - ta.scrollTop - mh - 4; // 커서 위로
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
  }

  // 커서 왼쪽에서 트리거 "/" 를 찾는다. 줄 시작이나 공백 바로 뒤의 "/" 만 인정하고,
  // "/" 와 커서 사이에 공백/줄바꿈이 없어야 한다(그 사이 글자가 검색어).
  function detectSlash() {
    const caret = ta.selectionStart;
    const value = ta.value;
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "\n") return null;
      if (ch === "/") {
        const prev = i === 0 ? "" : value[i - 1];
        if (i === 0 || prev === " " || prev === "\n" || prev === "\t") {
          return { start: i, query: value.slice(i + 1, caret) };
        }
        return null;
      }
      if (ch === " " || ch === "\t") return null;
      i--;
    }
    return null;
  }

  function filterBy(query) {
    const q = query.trim().toLowerCase();
    if (!q) return MENU_COMMANDS.slice();
    return MENU_COMMANDS.filter((c) =>
      t(c.key).toLowerCase().includes(q) || c.keys.some((k) => k.toLowerCase().includes(q)));
  }

  function refreshMenu() {
    const hit = detectSlash();
    if (!hit) { if (open) closeMenu(); return; }
    slashStart = hit.start;
    filtered = filterBy(hit.query);
    active = 0;
    open = true;
    renderMenu();
    positionMenu();
  }

  function choose(i) {
    const cmd = filtered[i];
    if (!cmd) { closeMenu(); return; }
    // 트리거 "/query" 를 지운 뒤 명령을 실행한다.
    const caret = ta.selectionStart;
    const value = ta.value;
    ta.value = value.slice(0, slashStart) + value.slice(caret);
    ta.setSelectionRange(slashStart, slashStart);
    closeMenu();
    cmd.run(ta);
  }

  ta.addEventListener("input", refreshMenu);
  ta.addEventListener("focus", showBar);
  ta.addEventListener("click", () => { if (open) refreshMenu(); });
  ta.addEventListener("blur", () => {
    // 메뉴/툴바 클릭으로 인한 blur 는 mousedown preventDefault 로 막으므로,
    // 여기 도달했다면 진짜 바깥으로 나간 것 → 정리.
    hideBar();
    closeMenu();
  });

  // 메뉴가 열려 있을 때 방향키/Enter/Tab/Esc 를 가로챈다(다른 keydown 핸들러보다 먼저).
  ta.addEventListener("keydown", (e) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation();
      active = filtered.length ? (active + 1) % filtered.length : 0; renderMenu();
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      active = filtered.length ? (active - 1 + filtered.length) % filtered.length : 0; renderMenu();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (!filtered.length) { closeMenu(); return; }
      e.preventDefault(); e.stopPropagation();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); // 편집 종료로 번지지 않게
      closeMenu();
    }
  }, true);

  // 스크롤/리사이즈 중 메뉴가 커서와 어긋나지 않게 따라가거나 닫는다.
  const reposition = () => { if (open) positionMenu(); };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  return { close: closeMenu };
}
