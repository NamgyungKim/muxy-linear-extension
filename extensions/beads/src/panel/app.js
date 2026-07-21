import { clear, h } from "@/lib/dom";
import { icon } from "@/lib/icons";
import {
  applyColumnOrder,
  groupIssuesByColumn,
  getIssueAge,
  getPriorityLabel,
  getStatusLabel,
  loadBoardData,
} from "./data";

const LAYOUT_STORAGE_KEY = "beads-board-layout";
const DEFAULT_AUTO_REFRESH_MS = 15000;
const DEFAULT_VIEW = "board";
const DEFAULT_INSPECTOR_WIDTH = 320;
const MIN_INSPECTOR_WIDTH = 260;
const MAX_INSPECTOR_WIDTH = 640;
const VIEWS = [
  { id: "board", label: "Board" },
  { id: "ledger", label: "Ledger" },
  { id: "ready", label: "Ready Path" },
];
const AUTO_REFRESH_OPTIONS = [
  { label: "Never", value: 0 },
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "5m", value: 300000 },
];

export class BeadsBoardPanel {
  constructor(root) {
    this.root = root;
    this.issues = [];
    this.filterText = "";
    this.selectedIssue = null;
    this.showDetail = false;
    this.projectName = "Workspace";
    this.workspacePath = null;
    this.source = "none";
    this.error = null;
    this.refreshing = false;
    this.pollTimer = null;
    this.autoRefreshMs = DEFAULT_AUTO_REFRESH_MS;
    this.activeView = DEFAULT_VIEW;
    this.inspectorWidth = DEFAULT_INSPECTOR_WIDTH;
    this.collapsedColumns = new Set();
    this.touchedColumns = new Set();
    this.columnOrder = [];
    this.draggingColumnID = null;
    this.suppressColumnClickUntil = 0;
    this.isTab = window.muxy?.data?.surface === "tab";
  }

  async start() {
    this.root.classList.add(this.isTab ? "surface-tab" : "surface-panel");
    muxy.events.subscribe("command.refresh-beads-board", () => this.refresh(true));
    muxy.events.subscribe("project.switched", () => this.delayedRefresh());
    muxy.events.subscribe("worktree.switched", () => this.delayedRefresh());
    muxy.onFocus?.((focused) => {
      if (focused && !this.selectedIssue) this.root.querySelector(".search-input")?.focus();
    });
    await this.loadLayout();
    this.render();
    this.refresh(true);
    this.applyAutoRefreshTimer();
  }

  destroy() {
    this.clearAutoRefreshTimer();
  }

  delayedRefresh() {
    this.issues = [];
    this.selectedIssue = null;
    this.showDetail = false;
    this.error = null;
    this.collapsedColumns = new Set();
    this.touchedColumns = new Set();
    this.draggingColumnID = null;
    this.render();
    setTimeout(() => this.refresh(true), 300);
  }

  async refresh(force) {
    if (this.refreshing) return;
    this.refreshing = true;
    if (force && this.issues.length === 0) this.render();

    try {
      const data = await loadBoardData();
      this.issues = data.issues;
      this.projectName = data.projectName;
      this.workspacePath = data.workspacePath;
      this.source = data.source;
      this.error = data.error;
      this.syncSelectedIssue();
      this.updateTopbar();
    } catch (error) {
      this.error = error?.message ?? String(error);
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  updateTopbar() {
    try {
      muxy.topbar.set({ id: "beads-board", visible: true });
    } catch {
    }
  }

  syncSelectedIssue() {
    if (!this.selectedIssue) return;
    this.selectedIssue = this.issues.find((issue) => issue.id === this.selectedIssue.id) ?? null;
  }

  render() {
    clear(this.root);
    if (this.selectedIssue && this.showDetail && !this.isTab) {
      this.root.appendChild(this.renderDetailPage());
      return;
    }

    this.root.appendChild(h("div", { class: "app-shell" },
      this.renderTopbar(),
      this.error && this.issues.length === 0 ? this.renderNotice() : null,
      this.issues.length === 0 ? this.renderEmpty() : this.renderActiveView(),
    ));
  }

  renderTopbar() {
    return h("header", { class: "app-topbar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }), h("strong", {}, "Beads")),
      h("span", { class: "project-name", title: this.workspacePath || "" }, this.projectName),
      h("nav", { class: "view-switcher", "aria-label": "Issue view" }, VIEWS.map((view) => h("button", {
        class: `view-button${this.activeView === view.id ? " is-active" : ""}`,
        "aria-pressed": this.activeView === view.id,
        onclick: () => this.setView(view.id),
      }, view.label))),
      h("div", { class: "topbar-spacer" }),
      h("label", { class: "search-control" },
        icon("search", 12),
        h("input", {
          class: "search-input",
          placeholder: "Filter issues…",
          value: this.filterText,
          oninput: (event) => {
            this.filterText = event.target.value;
            this.render();
            this.root.querySelector(".search-input")?.focus();
          },
          onkeydown: (event) => {
            if (event.key === "Escape") {
              this.filterText = "";
              this.render();
            }
          },
        }),
        this.filterText ? h("button", {
          class: "clear-search",
          title: "Clear filter",
          onclick: () => {
            this.filterText = "";
            this.render();
          },
        }, icon("x", 12)) : null,
      ),
      h("button", {
        class: "icon-button",
        title: "Refresh beads",
        disabled: this.refreshing,
        onclick: () => this.refresh(true),
      }, icon("refresh", 13)),
      h("select", {
        class: "refresh-select",
        title: "Auto-refresh interval",
        onchange: (event) => this.setAutoRefresh(Number(event.target.value)),
      }, AUTO_REFRESH_OPTIONS.map((option) => h("option", {
        value: option.value,
        selected: option.value === this.autoRefreshMs,
      }, option.label))),
    );
  }

  renderActiveView() {
    if (this.activeView === "ledger") return this.renderLedger();
    if (this.activeView === "ready") return this.renderReadyPath();
    return this.renderBoard();
  }

  renderBoard() {
    this.reconcileCollapsedColumns(this.orderBuckets(groupIssuesByColumn(this.issues)));
    const content = h("section", { class: "board-workspace" },
      this.renderSummary(),
      h("div", { class: "columns" }, this.orderBuckets(groupIssuesByColumn(this.getFilteredIssues()))
        .map((bucket) => this.renderColumn(bucket))),
    );
    return h("main", {
      class: `view-layout board-layout${this.selectedIssue ? " has-selection" : ""}`,
      style: `--inspector-width:${this.inspectorWidth}px`,
    },
      content,
      this.selectedIssue ? this.renderInspector(this.selectedIssue) : null,
    );
  }

  renderSummary() {
    const active = this.issues.filter((issue) => issue.status !== "closed").length;
    const ready = this.issues.filter((issue) => issue.ready).length;
    const blocked = this.issues.filter((issue) => issue.status === "blocked").length;
    const closed = this.issues.filter((issue) => issue.status === "closed").length;
    const total = this.issues.length || 1;
    return h("div", { class: "summary" },
      h("div", { class: "summary-copy" }, h("strong", {}, this.projectName), h("span", {}, `${active} active issues`)),
      this.renderMetric(ready, "ready"),
      this.renderMetric(blocked, "blocked"),
      h("div", { class: "progress" },
        h("span", {}, `${closed} of ${this.issues.length} closed`),
        h("div", { class: "progress-track" }, h("i", { style: `width:${Math.round((closed / total) * 100)}%` })),
      ),
    );
  }

  renderMetric(value, label) {
    return h("div", { class: "summary-metric" }, h("b", {}, value), h("span", {}, label));
  }

  renderColumn(bucket) {
    const isCollapsed = this.collapsedColumns.has(bucket.id);
    const attrs = {
      class: `column column-${bucket.id}${isCollapsed ? " is-collapsed" : ""}`,
      ondragenter: (event) => this.handleColumnDragEnter(event, bucket.id),
      ondragover: (event) => this.handleColumnDragOver(event, bucket.id),
      ondragleave: (event) => this.handleColumnDragLeave(event, bucket.id),
      ondrop: (event) => this.handleColumnDrop(event, bucket.id),
    };

    if (isCollapsed) {
      return h("button", {
        ...attrs,
        draggable: true,
        title: `Open ${bucket.title}`,
        onclick: () => this.toggleColumn(bucket.id),
        ondragstart: (event) => this.handleColumnDragStart(event, bucket.id),
        ondragend: () => this.handleColumnDragEnd(),
      }, h("span", { class: "collapsed-count" }, bucket.issues.length), h("span", { class: "collapsed-title" }, bucket.title));
    }

    return h("section", attrs,
      h("button", {
        class: "column-header",
        draggable: true,
        title: `Collapse ${bucket.title}`,
        onclick: () => this.toggleColumn(bucket.id),
        ondragstart: (event) => this.handleColumnDragStart(event, bucket.id),
        ondragend: () => this.handleColumnDragEnd(),
      }, h("span", { class: "column-title" }, bucket.title), h("span", { class: "column-count" }, bucket.issues.length)),
      h("div", { class: "column-body" }, bucket.issues.length === 0
        ? h("div", { class: "column-empty" }, "No issues")
        : bucket.issues.map((issue) => this.renderCard(issue))),
    );
  }

  renderCard(issue) {
    return h("button", {
      class: `card priority-${issue.priority ?? "unknown"}${this.selectedIssue?.id === issue.id ? " is-selected" : ""}`,
      onclick: () => this.selectIssue(issue),
    },
      h("div", { class: "card-topline" },
        h("span", { class: "issue-id" }, issue.id),
        h("span", { class: `priority priority-${issue.priority ?? "unknown"}` }, getPriorityLabel(issue.priority)),
      ),
      h("div", { class: "card-title" }, issue.title),
      h("div", { class: "card-meta" },
        issue.ready ? h("span", { class: "badge badge-ready" }, "Ready") : null,
        h("span", { class: "muted" }, issue.issue_type),
        getIssueAge(issue) ? h("span", { class: "muted" }, getIssueAge(issue)) : null,
      ),
    );
  }

  renderLedger() {
    const issues = this.getFilteredIssues();
    return h("main", {
      class: `view-layout ledger-layout${this.selectedIssue ? " has-selection" : ""}`,
      style: `--inspector-width:${this.inspectorWidth}px`,
    },
      h("section", { class: "ledger-workspace" },
        h("div", { class: "view-heading" },
          h("div", {}, h("h1", {}, "Dependency ledger"), h("p", {}, "Ready work first, with blockers and downstream impact visible.")),
          h("span", { class: "result-count" }, `${issues.length} issues`),
        ),
        h("div", { class: "ledger-scroll" },
          h("div", { class: "ledger-table", "aria-label": "Beads issues" },
            h("div", { class: "ledger-row ledger-head" },
              h("span", {}, ""), h("span", {}, "ID"), h("span", {}, "Issue"), h("span", {}, "State"), h("span", {}, "Priority"), h("span", {}, "Links")),
            issues.map((issue) => this.renderLedgerRow(issue)),
          ),
        ),
      ),
      this.selectedIssue ? this.renderInspector(this.selectedIssue) : null,
    );
  }

  renderLedgerRow(issue) {
    const links = `${issue.dependency_count} → ${issue.dependent_count}`;
    return h("button", {
      class: `ledger-row${this.selectedIssue?.id === issue.id ? " is-selected" : ""}`,
      onclick: () => this.selectIssue(issue),
    },
      h("span", { class: `state-dot status-${issue.status}` }),
      h("span", { class: "issue-id" }, issue.id),
      h("span", { class: "ledger-issue" }, h("b", {}, issue.title), h("small", {}, [issue.issue_type, ...issue.labels].slice(0, 3).join(" · "))),
      h("span", {}, h("span", { class: `badge status-${issue.status}${issue.ready ? " badge-ready" : ""}` }, issue.ready ? "Ready" : getStatusLabel(issue.status))),
      h("span", {}, h("span", { class: `priority priority-${issue.priority ?? "unknown"}` }, getPriorityLabel(issue.priority))),
      h("span", { class: "dependency-links" }, links),
    );
  }

  renderReadyPath() {
    const issues = this.getReadyPathIssues();
    const selected = issues.find((issue) => issue.id === this.selectedIssue?.id) || issues[0] || null;
    return h("main", { class: "ready-layout" },
      h("section", { class: "ready-queue" },
        h("div", { class: "view-heading" }, h("div", {}, h("h1", {}, "What can move next?"), h("p", {}, "Ranked by readiness, priority, and downstream impact."))),
        h("div", { class: "ready-list" }, issues.map((issue, index) => h("button", {
          class: `ready-item${selected?.id === issue.id ? " is-selected" : ""}`,
          onclick: () => this.selectIssue(issue),
        },
          h("span", { class: "ready-rank" }, index + 1),
          h("span", { class: "ready-copy" }, h("b", {}, issue.title), h("small", {}, this.getReadyReason(issue))),
          h("span", { class: "issue-id" }, getPriorityLabel(issue.priority)),
        ))),
      ),
      selected ? this.renderReadyFocus(selected) : this.renderNoMatches(),
    );
  }

  renderReadyFocus(issue) {
    return h("section", { class: "ready-focus" }, h("div", { class: "focus-inner" },
      h("div", { class: "detail-kicker" }, `${issue.id} · NEXT UP`),
      h("h1", {}, issue.title),
      this.renderBadges(issue),
      h("section", { class: "detail-section" }, h("h2", {}, "Why this is next"), h("p", {}, this.getReadyReason(issue))),
      h("section", { class: "detail-section" },
        h("h2", {}, "Work path"),
        h("div", { class: "work-path" },
          h("div", { class: "path-card" }, h("small", {}, "BLOCKED BY"), h("b", {}, issue.dependency_count ? `${issue.dependency_count} dependencies` : "No blockers")),
          h("span", { class: "path-arrow" }, "→"),
          h("div", { class: "path-card" }, h("small", {}, "UNLOCKS"), h("b", {}, `${issue.dependent_count} downstream issues`)),
        ),
      ),
      issue.acceptance_criteria ? this.renderField("Acceptance", issue.acceptance_criteria) : null,
      issue.description ? this.renderField("Description", issue.description) : null,
    ));
  }

  getReadyPathIssues() {
    return [...this.getFilteredIssues()]
      .filter((issue) => issue.status !== "closed")
      .sort((a, b) => {
        if (a.ready !== b.ready) return a.ready ? -1 : 1;
        const priority = (a.priority ?? 99) - (b.priority ?? 99);
        if (priority) return priority;
        return (b.dependent_count || 0) - (a.dependent_count || 0);
      });
  }

  getReadyReason(issue) {
    if (!issue.ready && issue.status === "blocked") return `${issue.dependency_count || "Unresolved"} blockers need attention`;
    if (!issue.ready) return `${getStatusLabel(issue.status)} · ${issue.dependent_count} downstream issues`;
    if (issue.dependent_count > 0) return `Ready now · unlocks ${issue.dependent_count} downstream issues`;
    return "Ready now · no unresolved dependencies";
  }

  renderInspector(issue) {
    return h("aside", { class: "inspector" },
      h("div", {
        class: "inspector-resizer",
        role: "separator",
        tabindex: "0",
        "aria-label": "Resize issue details",
        "aria-orientation": "vertical",
        "aria-valuemin": MIN_INSPECTOR_WIDTH,
        "aria-valuemax": MAX_INSPECTOR_WIDTH,
        "aria-valuenow": this.inspectorWidth,
        onpointerdown: (event) => this.startInspectorResize(event),
        onkeydown: (event) => this.handleInspectorResizeKey(event),
      }, h("span", {})),
      h("div", { class: "inspector-head" },
        h("button", { class: "icon-button close-inspector", title: "Close details", onclick: () => { this.selectedIssue = null; this.render(); } }, icon("x", 13)),
        h("div", { class: "detail-kicker" }, issue.id),
        h("h1", {}, issue.title),
        this.renderBadges(issue),
      ),
      h("div", { class: "inspector-body" },
        this.renderField("Description", issue.description),
        this.renderField("Design", issue.design),
        this.renderField("Acceptance", issue.acceptance_criteria),
        this.renderField("Notes", issue.notes),
        this.renderStats(issue),
      ),
    );
  }

  renderDetailPage() {
    const issue = this.selectedIssue;
    return h("div", { class: "detail-page" },
      h("header", { class: "detail-topbar" },
        h("button", { class: "back-button", onclick: () => { this.showDetail = false; this.render(); } }, icon("chevronLeft", 14), this.getActiveViewLabel()),
        h("button", { class: "icon-button", title: "Refresh beads", onclick: () => this.refresh(true) }, icon("refresh", 13)),
      ),
      h("div", { class: "detail-page-body" },
        h("div", { class: "detail-kicker" }, issue.id),
        h("h1", {}, issue.title),
        this.renderBadges(issue),
        this.renderField("Description", issue.description),
        this.renderField("Design", issue.design),
        this.renderField("Acceptance", issue.acceptance_criteria),
        this.renderField("Notes", issue.notes),
        this.renderStats(issue),
      ),
    );
  }

  renderBadges(issue) {
    return h("div", { class: "detail-badges" },
      h("span", { class: `priority priority-${issue.priority ?? "unknown"}` }, getPriorityLabel(issue.priority)),
      h("span", { class: `badge status-${issue.status}` }, getStatusLabel(issue.status)),
      issue.ready ? h("span", { class: "badge badge-ready" }, "Ready") : null,
      h("span", { class: "badge" }, issue.issue_type),
    );
  }

  renderField(label, value) {
    if (!value) return null;
    return h("section", { class: "detail-section" }, h("h2", {}, label), h("p", {}, value));
  }

  renderStats(issue) {
    return h("section", { class: "detail-section" },
      h("h2", {}, "Activity"),
      h("div", { class: "stat-grid" },
        this.renderStat(issue.dependency_count, "blockers"),
        this.renderStat(issue.dependent_count, "dependents"),
        this.renderStat(issue.comment_count, "comments"),
      ),
    );
  }

  renderStat(value, label) {
    return h("div", {}, h("span", {}, value), h("small", {}, label));
  }

  renderNotice() {
    return h("div", { class: "notice" }, icon("alertCircle", 14), h("span", {}, this.error));
  }

  renderEmpty() {
    return h("div", { class: "empty-state" },
      icon("rectangle3group", 28),
      h("div", { class: "empty-title" }, this.filterText ? "No matching issues" : "No beads found"),
      h("div", { class: "empty-copy" }, this.filterText ? "Try a different filter." : "Open a workspace with a Beads database or exported issues.jsonl."),
      !this.filterText ? h("div", { class: "debug" },
        h("div", {}, `project: ${this.projectName || "unknown"}`),
        h("div", {}, `workspace: ${this.workspacePath || "not set"}`),
        h("div", {}, `source: ${this.source}`),
      ) : null,
    );
  }

  renderNoMatches() {
    return h("div", { class: "empty-state" }, h("div", { class: "empty-title" }, "No matching active issues"), h("div", { class: "empty-copy" }, "Change the filter to rebuild the ready path."));
  }

  selectIssue(issue) {
    this.selectedIssue = issue;
    this.showDetail = !this.isTab;
    this.render();
  }

  setView(view) {
    if (!VIEWS.some((item) => item.id === view)) return;
    this.activeView = view;
    this.showDetail = false;
    if (view === "ready" && !this.selectedIssue) this.selectedIssue = this.getReadyPathIssues()[0] || null;
    this.saveLayout();
    this.render();
  }

  getActiveViewLabel() {
    return VIEWS.find((view) => view.id === this.activeView)?.label || "Issues";
  }

  toggleColumn(columnID) {
    if (Date.now() < this.suppressColumnClickUntil) return;
    this.touchedColumns.add(columnID);
    if (this.collapsedColumns.has(columnID)) this.collapsedColumns.delete(columnID);
    else this.collapsedColumns.add(columnID);
    this.render();
  }

  reconcileCollapsedColumns(buckets) {
    for (const bucket of buckets) {
      if (this.touchedColumns.has(bucket.id)) continue;
      if (bucket.issues.length === 0) this.collapsedColumns.add(bucket.id);
      else this.collapsedColumns.delete(bucket.id);
    }
  }

  orderBuckets(buckets) {
    return applyColumnOrder(buckets, this.columnOrder);
  }

  async loadLayout() {
    try {
      const layout = await muxy.storage.get(LAYOUT_STORAGE_KEY);
      this.columnOrder = Array.isArray(layout?.columnOrder) ? layout.columnOrder : [];
      this.autoRefreshMs = this.normalizeAutoRefreshMs(layout?.autoRefreshMs);
      this.activeView = VIEWS.some((view) => view.id === layout?.activeView) ? layout.activeView : DEFAULT_VIEW;
      this.inspectorWidth = this.normalizeInspectorWidth(layout?.inspectorWidth);
    } catch {
      this.columnOrder = [];
      this.autoRefreshMs = DEFAULT_AUTO_REFRESH_MS;
      this.activeView = DEFAULT_VIEW;
      this.inspectorWidth = DEFAULT_INSPECTOR_WIDTH;
    }
  }

  async saveLayout() {
    try {
      await muxy.storage.set(LAYOUT_STORAGE_KEY, {
        columnOrder: this.columnOrder,
        autoRefreshMs: this.autoRefreshMs,
        activeView: this.activeView,
        inspectorWidth: this.inspectorWidth,
      });
    } catch {
    }
  }

  normalizeAutoRefreshMs(value) {
    const numeric = Number(value);
    return AUTO_REFRESH_OPTIONS.some((option) => option.value === numeric) ? numeric : DEFAULT_AUTO_REFRESH_MS;
  }

  normalizeInspectorWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_INSPECTOR_WIDTH;
    return Math.round(Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, numeric)));
  }

  startInspectorResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.inspectorWidth;
    const resizer = event.currentTarget;
    resizer.setPointerCapture?.(event.pointerId);
    document.body.classList.add("is-resizing-inspector");

    const handleMove = (moveEvent) => {
      const viewportLimit = Math.max(MIN_INSPECTOR_WIDTH, window.innerWidth - 360);
      this.inspectorWidth = this.normalizeInspectorWidth(Math.min(viewportLimit, startWidth + startX - moveEvent.clientX));
      this.root.querySelector(".view-layout")?.style.setProperty("--inspector-width", `${this.inspectorWidth}px`);
      resizer.setAttribute("aria-valuenow", String(this.inspectorWidth));
    };
    const handleUp = () => {
      document.body.classList.remove("is-resizing-inspector");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      this.saveLayout();
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }

  handleInspectorResizeKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? 20 : -20;
    this.inspectorWidth = this.normalizeInspectorWidth(this.inspectorWidth + delta);
    this.saveLayout();
    this.render();
    this.root.querySelector(".inspector-resizer")?.focus();
  }

  setAutoRefresh(value) {
    this.autoRefreshMs = this.normalizeAutoRefreshMs(value);
    this.applyAutoRefreshTimer();
    this.saveLayout();
  }

  applyAutoRefreshTimer() {
    this.clearAutoRefreshTimer();
    if (this.autoRefreshMs <= 0) return;
    this.pollTimer = setInterval(() => this.refresh(false), this.autoRefreshMs);
  }

  clearAutoRefreshTimer() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  handleColumnDragStart(event, columnID) {
    this.draggingColumnID = columnID;
    this.clearColumnDropTargets();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", columnID);
    event.stopPropagation();
  }

  handleColumnDragEnter(event, columnID) {
    if (!this.draggingColumnID || this.draggingColumnID === columnID) return;
    event.preventDefault();
    event.currentTarget.classList.add("is-drop-target");
  }

  handleColumnDragOver(event, columnID) {
    if (!this.draggingColumnID || this.draggingColumnID === columnID) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("is-drop-target");
  }

  handleColumnDragLeave(event, columnID) {
    if (!this.draggingColumnID || this.draggingColumnID === columnID) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    event.currentTarget.classList.remove("is-drop-target");
  }

  handleColumnDrop(event, targetColumnID) {
    event.preventDefault();
    event.stopPropagation();
    this.clearColumnDropTargets();
    const sourceColumnID = this.draggingColumnID || event.dataTransfer.getData("text/plain");
    if (!sourceColumnID || sourceColumnID === targetColumnID) return this.handleColumnDragEnd();
    const orderedIDs = this.orderBuckets(groupIssuesByColumn(this.issues)).map((bucket) => bucket.id);
    const sourceIndex = orderedIDs.indexOf(sourceColumnID);
    const targetIndex = orderedIDs.indexOf(targetColumnID);
    if (sourceIndex === -1 || targetIndex === -1) return this.handleColumnDragEnd();
    orderedIDs.splice(sourceIndex, 1);
    orderedIDs.splice(targetIndex, 0, sourceColumnID);
    this.columnOrder = orderedIDs;
    this.saveLayout();
    this.handleColumnDragEnd();
    this.render();
  }

  handleColumnDragEnd() {
    this.clearColumnDropTargets();
    this.draggingColumnID = null;
    this.suppressColumnClickUntil = Date.now() + 250;
  }

  clearColumnDropTargets() {
    this.root.querySelectorAll(".column.is-drop-target").forEach((node) => node.classList.remove("is-drop-target"));
  }

  getFilteredIssues() {
    if (!this.filterText) return this.issues;
    const query = this.filterText.toLowerCase();
    return this.issues.filter((issue) => [
      issue.id, issue.title, issue.description, issue.issue_type, issue.status, ...issue.labels,
    ].some((value) => String(value || "").toLowerCase().includes(query)));
  }
}
