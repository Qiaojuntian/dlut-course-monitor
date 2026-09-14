// ==UserScript==
// @name         DLUT Course Watcher
// @namespace    local.dlut.course-watcher
// @version      2.3.0
// @description  仅在用户手动登录后的选课页面中监测和串行提交课程
// @match        https://dutgs.dlut.edu.cn/pyxx/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function attachCourseWatcherPolicy(root) {
  const campusPattern = /开发区|盘锦/;
  const restrictionPattern = /非全日制|非全|仅限/;

  function normalizeTitle(title = '') {
    return String(title)
      .replace(/\s+/g, '')
      .replace(/[（）()]/g, '')
      .trim();
  }

  function classifyCourse(course) {
    const groupKey = normalizeTitle(course.title);
    const actionText = String(course.actionText ?? '');
    const content = `${course.location ?? ''} ${course.notes ?? ''} ${course.allText ?? ''}`;

    if (actionText.includes('退选')) {
      return { eligible: false, reason: 'already-selected', groupKey };
    }
    if (!actionText.includes('选课')) {
      return { eligible: false, reason: 'no-select-action', groupKey };
    }
    if (campusPattern.test(content)) {
      return { eligible: false, reason: 'excluded-campus', groupKey };
    }
    if (restrictionPattern.test(content)) {
      return { eligible: false, reason: 'excluded-restriction', groupKey };
    }
    return { eligible: true, reason: 'eligible', groupKey };
  }

  function matchesManualExclusion(course, rules = []) {
    const code = String(course.code ?? '').trim();
    const title = normalizeTitle(course.title);
    return rules.some((rule) => {
      const normalizedRule = normalizeTitle(rule);
      return normalizedRule !== '' && (normalizedRule === code || normalizedRule === title);
    });
  }

  function chooseNext(courses, selectedGroupKeys = new Set()) {
    return (
      courses.find((course) => {
        const decision = classifyCourse(course);
        return decision.eligible && !selectedGroupKeys.has(decision.groupKey);
      }) ?? null
    );
  }

  root.CourseWatcherPolicy = {
    classifyCourse,
    chooseNext,
    matchesManualExclusion,
    normalizeTitle,
  };
})(globalThis);

(function attachCourseWatcherRuntime(root) {
  const defaultSchema = {
    location: 1,
    code: 3,
    title: 4,
    schedule: 6,
    status: 10,
    notes: 13,
  };

  function rowFromCells(cells, actionText, schema = defaultSchema, rowIndex = 0) {
    return {
      rowIndex,
      location: cells[schema.location] ?? '',
      code: cells[schema.code] ?? '',
      title: cells[schema.title] ?? '',
      schedule: cells[schema.schedule] ?? '',
      statusText: cells[schema.status] ?? '',
      notes: cells[schema.notes] ?? '',
      actionText: actionText ?? '',
      allText: cells.join(' '),
    };
  }

  function shouldReload(lastMutationAt, now, refreshMs) {
    return now - lastMutationAt >= refreshMs;
  }

  function refreshMsFromSeconds(value) {
    const parsed = Number(value);
    const seconds = Number.isFinite(parsed) ? Math.round(parsed) : 5;
    return Math.min(60, Math.max(1, seconds)) * 1_000;
  }

  function refreshDelayMs(lastMutationAt, now, refreshMs) {
    const elapsed = now - lastMutationAt;
    if (elapsed < 0 || elapsed >= refreshMs) return refreshMs;
    return Math.max(200, refreshMs - elapsed);
  }

  function knownAlertReason(message = '') {
    const text = String(message);
    if (/容纳人数已满|人数已满|容量已满/.test(text)) return 'capacity-full';
    if (/仅限选一门|已达上限|不可选择/.test(text)) return 'category-limit';
    if (/上课时间冲突/.test(text)) return 'time-conflict';
    if (/选课成功|成功选课|选择成功/.test(text)) return 'course-selected';
    return null;
  }

  function shouldWaitForManualNext(debugMode, reason) {
    return debugMode === true && reason === 'course-selected';
  }

  function shouldAutoDismissAlert(running, reason) {
    return running === true && reason != null;
  }

  function normalizeExclusionRules(value = '') {
    return [
      ...new Set(
        String(value)
          .split(/\r?\n/)
          .flatMap((line) => {
            const rule = line.trim();
            if (!rule) return [];
            const tokens = rule.split(/\s+/);
            const codes = tokens.filter((token) => /^\d{8,}$/.test(token));
            if (codes.length === 0) return [rule];
            const title = tokens.filter((token) => !/^\d{8,}$/.test(token)).join(' ');
            return [...(title ? [title] : []), ...codes];
          }),
      ),
    ];
  }

  function shouldAutoAcceptConfirm(message = '') {
    const text = String(message).replace(/\s+/g, '');
    return (
      /^上课时间冲突[，,：:]*是否继续选课[？?]?$/.test(text) ||
      /^确定要选择该课程[？?]?$/.test(text) ||
      /^确定要选该课程[？?]?$/.test(text)
    );
  }

  function shouldAutoContinueConflictModal(message = '', actionLabels = []) {
    const text = String(message).replace(/\s+/g, '');
    const isTimeConflict = /上课时间.*冲突|冲突.*上课时间/.test(text);
    const asksToContinue = /确定仍要选择/.test(text);
    const hasSafeAction = actionLabels.some(
      (label) => String(label).replace(/\s+/g, '') === '确定选择',
    );
    return (
      isTimeConflict &&
      asksToContinue &&
      hasSafeAction &&
      !/退选|替换|取消|放弃/.test(text)
    );
  }

  function safeModalAction(running, message = '', actionLabels = []) {
    if (!running) return null;
    if (shouldAutoContinueConflictModal(message, actionLabels)) {
      return '确定选择';
    }
    const reason = knownAlertReason(message);
    if (reason == null) return null;
    return actionLabels.some(
      (label) => String(label).replace(/\s+/g, '') === '确定',
    )
      ? '确定'
      : null;
  }

  function shouldHandleModalOnce(activeModal, visibleModal) {
    return visibleModal != null && activeModal !== visibleModal;
  }

  function modalAttemptDecision(visible, attempts, maxAttempts) {
    if (!visible) return 'closed';
    return attempts < maxAttempts ? 'retry' : 'stuck';
  }

  function chooseNextAttempt(
    candidates,
    selectedGroupKeys,
    lastAttemptAt,
    now,
    retryIntervalMs,
  ) {
    const dueCandidates = candidates.filter((candidate) => {
      if (selectedGroupKeys.has(candidate.groupKey)) return false;
      const lastAttempt = lastAttemptAt[candidate.groupKey];
      return lastAttempt == null || now - lastAttempt >= retryIntervalMs;
    });

    dueCandidates.sort((left, right) => {
      const leftAttempt = lastAttemptAt[left.groupKey] ?? Number.NEGATIVE_INFINITY;
      const rightAttempt = lastAttemptAt[right.groupKey] ?? Number.NEGATIVE_INFINITY;
      return leftAttempt - rightAttempt || left.rowIndex - right.rowIndex;
    });
    return dueCandidates[0] ?? null;
  }

  function canStart(state) {
    return state.previewed === true;
  }

  function actionLabel(element) {
    return String(element.value || element.innerText || element.textContent || '').trim();
  }

  function courseFromDomRow(row, rowIndex, schema = defaultSchema) {
    const cells = Array.from(row.cells ?? []).map((cell) =>
      String(cell.innerText || cell.textContent || '').trim(),
    );
    const actionElement = Array.from(row.querySelectorAll('a,input,button')).find(
      (element) => /选课|退选/.test(actionLabel(element)),
    );
    return rowFromCells(cells, actionElement ? actionLabel(actionElement) : '', schema, rowIndex);
  }

  function findCourseTable(document) {
    const scoredTables = Array.from(document.querySelectorAll('table')).map((table) => {
      const score = Array.from(table.querySelectorAll('tr')).filter((row) =>
        Array.from(row.querySelectorAll('a,input,button')).some((element) =>
          /选课|退选/.test(actionLabel(element)),
        ),
      ).length;
      return { table, score };
    });
    scoredTables.sort((left, right) => right.score - left.score);
    return scoredTables[0]?.score ? scoredTables[0].table : null;
  }

  function scanDocument(document, schema = defaultSchema) {
    const table = findCourseTable(document);
    if (table == null) return [];
    return Array.from(table.querySelectorAll('tr'))
      .map((row, rowIndex) => courseFromDomRow(row, rowIndex, schema))
      .filter((course) => course.title && /选课|退选/.test(course.actionText));
  }

  function detectStopReason(pageText = '') {
    const text = String(pageText);
    if (/验证码/.test(text)) return 'captcha';
    if (/系统繁忙|系统忙/.test(text)) return 'system-busy';
    if (/操作过于频繁|访问频繁|频率限制|请求过于频繁/.test(text)) return 'rate-limited';
    if (/登录超时|请重新登录|登录已失效/.test(text)) return 'login-expired';
    return null;
  }

  function findVisibleDialog(document) {
    const candidates = Array.from(
      document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal,.dialog,[class*="modal"],[class*="dialog"],[class*="window"],[id*="dialog"],[id*="window"]'),
    );
    return candidates.find((element) => {
      if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
      if (element.style?.display === 'none' || element.style?.visibility === 'hidden') return false;
      return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
    });
  }

  function isVisibleElement(element) {
    if (element == null || element.hidden) return false;
    if (element.getAttribute?.('aria-hidden') === 'true') return false;
    if (element.style?.display === 'none' || element.style?.visibility === 'hidden') {
      return false;
    }
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
  }

  function findVisibleDialogText(document) {
    const dialog = findVisibleDialog(document);
    return dialog == null ? null : String(dialog.innerText || dialog.textContent || '').trim();
  }

  function pageFingerprint(href, courses) {
    const url = String(href || '').split('#')[0];
    const courseKeys = courses
      .map((course) => `${course.code ?? ''}:${course.title ?? ''}`)
      .join('|');
    return `${url}::${courseKeys}`;
  }

  function isSameCoursePage(fingerprint, href) {
    const recordedUrl = String(fingerprint || '').split('::')[0];
    const currentUrl = String(href || '').split('#')[0];
    return recordedUrl !== '' && recordedUrl === currentUrl;
  }

  function summarizeCourses(courses, classifyCourse) {
    const eligible = [];
    const excluded = [];
    const selectedGroups = new Set();

    for (const course of courses) {
      const decision = classifyCourse(course);
      const classified = { ...course, ...decision };
      if (decision.reason === 'already-selected') {
        selectedGroups.add(decision.groupKey);
      } else if (decision.eligible) {
        eligible.push(classified);
      } else {
        excluded.push(classified);
      }
    }

    return { eligible, excluded, selectedGroups: [...selectedGroups] };
  }

  function syncSelectedGroups(state, observedSelectedGroups) {
    const selectedGroups = [
      ...new Set([...state.selectedGroups, ...observedSelectedGroups]),
    ];
    if (
      state.pending != null &&
      selectedGroups.includes(state.pending.groupKey)
    ) {
      return { ...state, pending: null, selectedGroups };
    }
    return { ...state, selectedGroups };
  }

  function releaseExpiredPending(state, now, verificationWindowMs) {
    if (
      state.pending != null &&
      now - state.pending.submittedAt >= verificationWindowMs
    ) {
      return { ...state, pending: null };
    }
    return state;
  }

  function reduceState(state, event) {
    if (event.type === 'queue' && state.pending == null) {
      return {
        ...state,
        pending: {
          rowIndex: event.rowIndex,
          groupKey: event.groupKey,
          attempts: 1,
        },
      };
    }
    if (event.type === 'confirmed') {
      return {
        ...state,
        pending: null,
        selectedGroups: [...new Set([...state.selectedGroups, event.groupKey])],
      };
    }
    return state;
  }

  function createBrowserController(window, document, policy) {
    const storageKey = 'dlut-course-watcher-state-v1';
    const preferencesKey = 'dlut-course-watcher-preferences-v1';
    const defaultState = {
      running: false,
      previewed: false,
      pending: null,
      selectedGroups: [],
      lastAttemptAt: {},
      manualExclusions: [],
      debugMode: false,
      awaitingManualNext: false,
      pageFingerprint: null,
      lastMutationAt: Date.now(),
      refreshMs: 5_000,
      retryMs: 5_000,
      verificationWindowMs: 1_500,
      pauseReason: '',
    };
    const storage = window.sessionStorage;
    const preferencesStorage = window.localStorage ?? storage;
    let observer = null;
    let modalObserver = null;
    let modalTimer = null;
    let modalAction = null;
    let modalRetryTimer = null;
    let refreshTimer = null;
    let verificationTimer = null;
    let attemptTimer = null;
    let handling = false;
    let panel = null;
    let logElement = null;
    let statusElement = null;
    let state = loadState();

    function loadState() {
      try {
        return {
          ...defaultState,
          ...JSON.parse(storage.getItem(storageKey) || '{}'),
          ...loadPreferences(),
        };
      } catch {
        return { ...defaultState, ...loadPreferences() };
      }
    }

    function loadPreferences() {
      try {
        const preferences = JSON.parse(preferencesStorage.getItem(preferencesKey) || '{}');
        return {
          manualExclusions: Array.isArray(preferences.manualExclusions)
            ? preferences.manualExclusions
            : [],
          refreshMs: Number.isFinite(preferences.refreshMs)
            ? preferences.refreshMs
            : defaultState.refreshMs,
          retryMs: Number.isFinite(preferences.retryMs)
            ? preferences.retryMs
            : defaultState.retryMs,
          debugMode: preferences.debugMode === true,
        };
      } catch {
        return {};
      }
    }

    function savePreferences() {
      try {
        preferencesStorage.setItem(
          preferencesKey,
          JSON.stringify({
            manualExclusions: state.manualExclusions,
            refreshMs: state.refreshMs,
            retryMs: state.retryMs,
            debugMode: state.debugMode,
          }),
        );
      } catch {
        // Keep the current tab functional when browser storage is unavailable.
      }
    }

    function saveState() {
      storage.setItem(storageKey, JSON.stringify(state));
      savePreferences();
      renderStatus();
    }

    function writeLog(message) {
      const timestamp = new Date().toLocaleTimeString();
      if (logElement != null) {
        logElement.textContent = `[${timestamp}] ${message}\n${logElement.textContent}`;
      }
    }

    function renderStatus() {
      if (statusElement == null) return;
      const mode = state.awaitingManualNext
        ? '等待手动下一门'
        : state.running
          ? '监测中'
          : state.previewed
            ? '已校验'
            : '待启动';
      const pending = state.pending == null ? '无待确认课程' : `核验：${state.pending.groupKey}`;
      statusElement.textContent = `${mode} | ${pending} | 选课 ${state.retryMs / 1000} 秒 | 刷新 ${state.refreshMs / 1000} 秒`;
    }

    function actionElementFromRow(row) {
      return Array.from(row.querySelectorAll('a,input,button')).find((element) =>
        /选课|退选/.test(actionLabel(element)),
      ) ?? null;
    }

    function scanEntries() {
      const table = findCourseTable(document);
      if (table == null) return [];
      return Array.from(table.querySelectorAll('tr'))
        .map((row, rowIndex) => ({
          course: courseFromDomRow(row, rowIndex),
          actionElement: actionElementFromRow(row),
        }))
        .filter(({ course }) => course.title && /选课|退选/.test(course.actionText));
    }

    function classifyForCurrentPolicy(course) {
      const decision = policy.classifyCourse(course);
      if (
        decision.eligible &&
        policy.matchesManualExclusion(course, state.manualExclusions)
      ) {
        return { ...decision, eligible: false, reason: 'manual-exclusion' };
      }
      return decision;
    }

    function currentPageFingerprint(entries = scanEntries()) {
      return pageFingerprint(
        window.location.href,
        entries.map(({ course }) => course),
      );
    }

    function requireFreshPreview(entries = scanEntries()) {
      if (isSameCoursePage(state.pageFingerprint, window.location.href)) return true;
      state = {
        ...defaultState,
        manualExclusions: state.manualExclusions,
        refreshMs: state.refreshMs,
        retryMs: state.retryMs,
        debugMode: state.debugMode,
        lastMutationAt: Date.now(),
        pauseReason: '页面或课程列表已变化，需要重新预览',
      };
      saveState();
      writeLog(state.pauseReason);
      return false;
    }

    function pause(reason) {
      state = { ...state, running: false, pauseReason: reason };
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      if (verificationTimer != null) window.clearTimeout(verificationTimer);
      if (attemptTimer != null) window.clearTimeout(attemptTimer);
      if (modalRetryTimer != null) window.clearTimeout(modalRetryTimer);
      refreshTimer = null;
      verificationTimer = null;
      attemptTimer = null;
      modalRetryTimer = null;
      modalAction = null;
      saveState();
      writeLog(`已暂停：${reason}`);
    }

    function beep() {
      try {
        const context = new window.AudioContext();
        const oscillator = context.createOscillator();
        oscillator.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.15);
      } catch {
        // Audio can be unavailable until the user interacts with the page.
      }
    }

    function inspectPage() {
      const safetyReason = detectStopReason(document.body?.innerText || '');
      if (safetyReason != null) {
        pause(`检测到 ${safetyReason}`);
        return null;
      }
      if (processVisibleModal()) return null;

      const entries = scanEntries();
      if (entries.length === 0) {
        pause('未找到包含选课或退选控件的课程表');
        return null;
      }

      const summary = summarizeCourses(
        entries.map(({ course }) => course),
        classifyForCurrentPolicy,
      );
      const pendingBeforeSync = state.pending;
      state = syncSelectedGroups(state, summary.selectedGroups);
      if (pendingBeforeSync != null && state.pending == null) {
        finishAttempt('course-selected', pendingBeforeSync.groupKey, true);
      } else {
        saveState();
      }
      return { entries, summary };
    }

    function processVisibleModal() {
      if (!state.running) return false;
      const dialog = findVisibleDialog(document);
      if (dialog == null) {
        clearModalAction();
        return false;
      }
      if (modalAction?.dialog === dialog) return true;
      clearModalAction();

      const actions = Array.from(document.querySelectorAll('button,input,a')).filter(
        isVisibleElement,
      );
      const actionLabels = actions.map(actionLabel);
      const dialogText = String(dialog.innerText || dialog.textContent || '');
      const targetLabel = safeModalAction(state.running, dialogText, actionLabels);
      if (targetLabel == null) {
        pause(`检测到未识别页面弹窗：${dialogText.slice(0, 80)}`);
        return true;
      }

      const action = actions.find(
        (element) => actionLabel(element).replace(/\s+/g, '') === targetLabel,
      );
      if (action == null) {
        pause(`弹窗缺少安全确认按钮：${dialogText.slice(0, 80)}`);
        return true;
      }

      modalAction = {
        dialog,
        targetLabel,
        reason: knownAlertReason(dialogText),
        attempts: 0,
      };
      clickModalAction();
      return true;
    }

    function clearModalAction() {
      if (modalRetryTimer != null) window.clearTimeout(modalRetryTimer);
      modalRetryTimer = null;
      modalAction = null;
    }

    function clickModalAction() {
      if (modalAction == null || !state.running) return;
      const visibleModal = findVisibleDialog(document);
      const decision = modalAttemptDecision(
        visibleModal === modalAction.dialog,
        modalAction.attempts,
        2,
      );
      if (decision === 'closed') {
        const completedAction = modalAction;
        clearModalAction();
        if (
          completedAction.targetLabel !== '确定选择' &&
          completedAction.reason != null
        ) {
          handleKnownFeedback(completedAction.reason);
        }
        return;
      }
      if (decision === 'stuck') {
        pause('确认按钮已重试 2 次但弹窗未关闭');
        return;
      }

      const actions = Array.from(document.querySelectorAll('button,input,a')).filter(
        isVisibleElement,
      );
      const action = actions.find(
        (element) => actionLabel(element).replace(/\s+/g, '') === modalAction.targetLabel,
      );
      if (action == null) {
        pause('确认按钮在重试时不可见');
        return;
      }

      modalAction.attempts += 1;
      if (modalAction.targetLabel === '确定选择') {
        writeLog(`自动确认页面内上课时间冲突（${modalAction.attempts}/2）`);
      } else {
        writeLog(`自动确认页面内提示：${modalAction.reason}（${modalAction.attempts}/2）`);
      }
      try {
        action.focus?.({ preventScroll: true });
        action.click();
      } catch {
        pause('确认按钮点击失败');
        return;
      }

      modalRetryTimer = window.setTimeout(() => clickModalAction(), 500);
    }

    function scheduleNormalRefresh() {
      if (!state.running) return;
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      const delay = refreshDelayMs(
        state.lastMutationAt,
        Date.now(),
        state.refreshMs,
      );
      refreshTimer = window.setTimeout(() => {
        if (!state.running) return;
        if (shouldReload(state.lastMutationAt, Date.now(), state.refreshMs)) {
          writeLog('课程表未自行更新，执行正常页面刷新');
          window.location.reload();
          return;
        }
        scheduleNormalRefresh();
      }, delay);
    }

    function verifyPendingThenSchedule() {
      if (!state.running) return;
      inspectPage();
      if (state.pending != null) {
        const pendingBeforeRelease = state.pending;
        state = releaseExpiredPending(
          state,
          Date.now(),
          state.verificationWindowMs,
        );
        if (state.pending == null) {
          finishAttempt('verification-timeout', pendingBeforeRelease.groupKey);
        }
      }
      scheduleNormalRefresh();
    }

    function schedulePendingVerification() {
      if (!state.running || state.pending == null) return;
      if (verificationTimer != null) window.clearTimeout(verificationTimer);
      const elapsed = Date.now() - state.pending.submittedAt;
      const delay = Math.max(200, state.verificationWindowMs - elapsed);
      verificationTimer = window.setTimeout(verifyPendingThenSchedule, delay);
    }

    function scheduleNextAttempt() {
      if (!state.running || state.awaitingManualNext) return;
      if (attemptTimer != null) window.clearTimeout(attemptTimer);
      attemptTimer = window.setTimeout(() => {
        attemptTimer = null;
        runCycle();
      }, state.retryMs);
    }

    function finishAttempt(reason, groupKey, selected = false) {
      state = {
        ...state,
        pending: null,
        selectedGroups: selected
          ? [...new Set([...state.selectedGroups, groupKey])]
          : state.selectedGroups,
        lastMutationAt: Date.now(),
        awaitingManualNext: shouldWaitForManualNext(state.debugMode, reason),
      };
      saveState();
      writeLog(
        selected
          ? `已确认选中：${groupKey}`
          : `选课未成功：${reason}（${groupKey}）`,
      );
      if (selected) beep();
      scheduleNormalRefresh();
      if (state.awaitingManualNext) {
        writeLog('调试模式：点击“抢下一门”后才继续');
      } else {
        scheduleNextAttempt();
      }
    }

    function submitNext(snapshot, force = false) {
      if (!state.running || state.pending != null) return;
      const candidate = chooseNextAttempt(
        snapshot.summary.eligible,
        new Set(state.selectedGroups),
        state.lastAttemptAt,
        Date.now(),
        force ? 0 : state.retryMs,
      );
      if (candidate == null) {
        scheduleNormalRefresh();
        scheduleNextAttempt();
        return;
      }

      const entry = snapshot.entries.find(({ course }) => course.rowIndex === candidate.rowIndex);
      if (entry?.actionElement == null || !entry.course.actionText.includes('选课')) {
        pause(`课程行 ${candidate.title} 缺少可用的选课控件`);
        return;
      }

      const now = Date.now();
      state = reduceState(state, {
        type: 'queue',
        rowIndex: candidate.rowIndex,
        groupKey: candidate.groupKey,
      });
      state = {
        ...state,
        pending: { ...state.pending, submittedAt: now },
        lastAttemptAt: { ...state.lastAttemptAt, [candidate.groupKey]: now },
      };
      saveState();
      writeLog(`尝试选课：${candidate.title}`);
      entry.actionElement.click();
      schedulePendingVerification();
    }

    function runCycle(force = false) {
      if (handling) return;
      if (state.awaitingManualNext && !force) return;
      if (state.running && !requireFreshPreview()) return;
      handling = true;
      try {
        const snapshot = inspectPage();
        if (snapshot != null && state.running) {
          if (state.awaitingManualNext && !force) return;
          if (state.pending != null) {
            schedulePendingVerification();
            scheduleNormalRefresh();
          } else {
            submitNext(snapshot, force);
          }
        }
      } finally {
        handling = false;
      }
    }

    function attachObserver() {
      const table = findCourseTable(document);
      if (table == null || observer != null) return;
      observer = new window.MutationObserver(() => {
        state = { ...state, lastMutationAt: Date.now() };
        saveState();
        if (state.running) runCycle();
      });
      observer.observe(table, { childList: true, subtree: true, characterData: true });
    }

    function attachModalObserver() {
      if (modalObserver != null || document.documentElement == null) return;
      modalObserver = new window.MutationObserver(() => {
        if (!state.running || modalTimer != null) return;
        modalTimer = window.setTimeout(() => {
          modalTimer = null;
          processVisibleModal();
        }, 0);
      });
      modalObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
      });
    }

    function preview() {
      attachObserver();
      attachModalObserver();
      const snapshot = inspectPage();
      if (snapshot == null) return;
      state = {
        ...state,
        previewed: true,
        running: false,
        pageFingerprint: currentPageFingerprint(snapshot.entries),
        pauseReason: '',
      };
      saveState();
      const exclusions = snapshot.summary.excluded.reduce((counts, course) => {
        counts[course.reason] = (counts[course.reason] || 0) + 1;
        return counts;
      }, {});
      writeLog(
        `预览完成：候选 ${snapshot.summary.eligible.length}，已选组 ${snapshot.summary.selectedGroups.length}，排除 ${JSON.stringify(exclusions)}`,
      );
      writeLog(
        `候选课程：${snapshot.summary.eligible.map((course) => `${course.title}（${course.code || course.rowIndex}）`).join('，') || '无'}`,
      );
      writeLog(`已选课程组：${snapshot.summary.selectedGroups.join('，') || '无'}`);
    }

    function start() {
      if (!canStart(state)) {
        preview();
        if (!canStart(state)) return;
      }
      if (!requireFreshPreview()) return;
      state = { ...state, running: true, pauseReason: '', lastMutationAt: Date.now() };
      saveState();
      attachObserver();
      attachModalObserver();
      writeLog('开始监测；仅会使用当前页面的选课控件');
      runCycle();
    }

    function handleKnownFeedback(reason) {
      if (state.pending != null) {
        finishAttempt(reason, state.pending.groupKey, reason === 'course-selected');
        return;
      }
      state = {
        ...state,
        lastMutationAt: Date.now(),
        awaitingManualNext: shouldWaitForManualNext(state.debugMode, reason),
      };
      saveState();
      writeLog(`已自动处理：${reason}（课程状态将在列表刷新后核验）`);
      scheduleNormalRefresh();
      if (state.awaitingManualNext) {
        writeLog('调试模式：点击“抢下一门”后才继续');
      } else {
        scheduleNextAttempt();
      }
    }

    function dialogOwners() {
      const owners = [window];
      try {
        if (window.top != null && window.top !== window) owners.push(window.top);
      } catch {
        // A cross-origin top window cannot be inspected or modified.
      }
      return owners;
    }

    function handleConfirm(message, nativeConfirm) {
      const reason = knownAlertReason(message);
      if (
        state.running &&
        reason === 'course-selected'
      ) {
        handleKnownFeedback('course-selected');
        return true;
      }
      if (
        state.running &&
        state.pending != null &&
        shouldAutoAcceptConfirm(message)
      ) {
        writeLog(`自动确认：${String(message)}`);
        return true;
      }
      if (shouldAutoDismissAlert(state.running, reason)) {
        handleKnownFeedback(reason);
        return true;
      }
      pause(`需要人工确认：${String(message)}`);
      return nativeConfirm(message);
    }

    function handleAlert(message, nativeAlert) {
      const reason = knownAlertReason(message);
      if (shouldAutoDismissAlert(state.running, reason)) {
        handleKnownFeedback(reason);
        return;
      }
      pause(`未识别提示：${String(message)}`);
      return nativeAlert(message);
    }

    function installDialogInterceptors() {
      const bridgeKey = '__dlutCourseWatcherDialogBridgeV1';
      for (const owner of dialogOwners()) {
        try {
          let bridge = owner[bridgeKey];
          if (bridge == null) {
            bridge = {};
            owner[bridgeKey] = bridge;
          }
          bridge.handleConfirm = handleConfirm;
          bridge.handleAlert = handleAlert;
          if (bridge.confirmWrapped !== true && typeof owner.confirm === 'function') {
            bridge.nativeConfirm = owner.confirm.bind(owner);
            owner.confirm = (message) => owner[bridgeKey].handleConfirm(
              message,
              owner[bridgeKey].nativeConfirm,
            );
            bridge.confirmWrapped = true;
          }
          if (bridge.alertWrapped !== true && typeof owner.alert === 'function') {
            bridge.nativeAlert = owner.alert.bind(owner);
            owner.alert = (message) => owner[bridgeKey].handleAlert(
              message,
              owner[bridgeKey].nativeAlert,
            );
            bridge.alertWrapped = true;
          }
        } catch {
          // This owner cannot be modified, for example because it is cross-origin.
        }
      }
    }

    function setRefreshSeconds(value) {
      state = { ...state, refreshMs: refreshMsFromSeconds(value) };
      saveState();
      writeLog(`列表刷新间隔已设为 ${state.refreshMs / 1_000} 秒`);
      if (state.running) scheduleNormalRefresh();
    }

    function setRetrySeconds(value) {
      state = { ...state, retryMs: refreshMsFromSeconds(value) };
      saveState();
      writeLog(`选课重试间隔已设为 ${state.retryMs / 1_000} 秒`);
      if (state.running) scheduleNextAttempt();
    }

    function setDebugMode(enabled) {
      state = {
        ...state,
        debugMode: Boolean(enabled),
        awaitingManualNext: false,
      };
      saveState();
      writeLog(state.debugMode ? '已开启调试模式' : '已关闭调试模式');
    }

    function advanceNextCourse() {
      if (!state.running) {
        writeLog('请先点击“开始抢课”');
        return;
      }
      if (!state.debugMode) {
        writeLog('当前不是调试模式，脚本会自动继续');
        return;
      }
      if (!state.awaitingManualNext) {
        writeLog('当前课程尚未得到结果');
        return;
      }
      state = { ...state, awaitingManualNext: false };
      saveState();
      writeLog('手动进入下一门课程');
      runCycle(true);
    }

    function getState() {
      return { ...state };
    }

    function setManualExclusions(value) {
      const wasRunning = state.running;
      state = {
        ...state,
        manualExclusions: normalizeExclusionRules(value),
        previewed: false,
        pageFingerprint: null,
      };
      if (wasRunning) {
        pause('排除名单已更新，请重新开始监测');
      } else {
        saveState();
      }
      writeLog(`排除名单已更新：${state.manualExclusions.join('，') || '无'}`);
    }

    function mountPanel() {
      if (document.getElementById('dlut-course-watcher-panel') != null) return;
      panel = document.createElement('section');
      panel.id = 'dlut-course-watcher-panel';
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:280px;padding:12px;border:1px solid #7a8790;background:#ffffff;color:#17212b;font:13px/1.45 system-ui,sans-serif;box-shadow:0 3px 14px rgba(0,0,0,.22);';

      const title = document.createElement('strong');
      title.textContent = '选课监测';
      statusElement = document.createElement('div');
      statusElement.style.cssText = 'margin:6px 0;color:#43515c;';
      const settings = document.createElement('div');
      settings.style.cssText = 'display:grid;gap:6px;margin:8px 0;';
      const retryLabel = document.createElement('label');
      retryLabel.textContent = '选课重试间隔（秒，1-60）';
      const retryInput = document.createElement('input');
      retryInput.type = 'number';
      retryInput.min = '1';
      retryInput.max = '60';
      retryInput.step = '1';
      retryInput.value = String(state.retryMs / 1_000);
      retryInput.addEventListener('change', () => setRetrySeconds(retryInput.value));
      const debugLabel = document.createElement('label');
      const debugInput = document.createElement('input');
      debugInput.type = 'checkbox';
      debugInput.checked = state.debugMode;
      debugInput.addEventListener('change', () => setDebugMode(debugInput.checked));
      debugLabel.append(debugInput, ' 调试模式：选课成功后手动抢下一门');
      const refreshLabel = document.createElement('label');
      refreshLabel.textContent = '列表刷新间隔（秒，1-60）';
      const refreshInput = document.createElement('input');
      refreshInput.type = 'number';
      refreshInput.min = '1';
      refreshInput.max = '60';
      refreshInput.step = '1';
      refreshInput.value = String(state.refreshMs / 1_000);
      refreshInput.addEventListener('change', () => setRefreshSeconds(refreshInput.value));
      const exclusionLabel = document.createElement('label');
      exclusionLabel.textContent = '排除课程（每行课程号或完整名称）';
      const exclusionInput = document.createElement('textarea');
      exclusionInput.rows = 3;
      exclusionInput.value = state.manualExclusions.join('\n');
      exclusionInput.addEventListener('input', () => setManualExclusions(exclusionInput.value));
      settings.append(retryLabel, retryInput, debugLabel, refreshLabel, refreshInput, exclusionLabel, exclusionInput);

      const previewButton = document.createElement('button');
      previewButton.textContent = '检查名单';
      previewButton.addEventListener('click', preview);
      const startButton = document.createElement('button');
      startButton.textContent = '开始抢课';
      startButton.style.marginLeft = '6px';
      startButton.addEventListener('click', start);
      const pauseButton = document.createElement('button');
      pauseButton.textContent = '暂停';
      pauseButton.style.marginLeft = '6px';
      pauseButton.addEventListener('click', () => pause('用户手动暂停'));
      const nextButton = document.createElement('button');
      nextButton.textContent = '抢下一门';
      nextButton.style.marginLeft = '6px';
      nextButton.addEventListener('click', advanceNextCourse);
      logElement = document.createElement('pre');
      logElement.style.cssText = 'max-height:150px;overflow:auto;margin:8px 0 0;white-space:pre-wrap;border-top:1px solid #d7dde1;padding-top:8px;';
      panel.append(title, statusElement, settings, previewButton, startButton, pauseButton, nextButton, logElement);
      document.body.append(panel);
      renderStatus();
    }

    function restore() {
      mountPanel();
      installDialogInterceptors();
      if ((state.previewed || state.running) && !requireFreshPreview()) return;
      attachObserver();
      attachModalObserver();
      if (state.running) {
        writeLog('恢复当前标签的监测状态');
        runCycle();
      }
    }

    return {
      getState,
      advanceNextCourse,
      installDialogInterceptors,
      pause,
      preview,
      restore,
      setRefreshSeconds,
      setDebugMode,
      setManualExclusions,
      setRetrySeconds,
      start,
    };
  }

  root.CourseWatcherRuntime = {
    canStart,
    chooseNextAttempt,
    courseFromDomRow,
    createBrowserController,
    defaultSchema,
    detectStopReason,
    findCourseTable,
    findVisibleDialog,
    findVisibleDialogText,
    pageFingerprint,
    knownAlertReason,
    isSameCoursePage,
    isVisibleElement,
    modalAttemptDecision,
    normalizeExclusionRules,
    refreshDelayMs,
    refreshMsFromSeconds,
    releaseExpiredPending,
    reduceState,
    rowFromCells,
    safeModalAction,
    shouldAutoAcceptConfirm,
    shouldAutoDismissAlert,
    shouldAutoContinueConflictModal,
    shouldHandleModalOnce,
    shouldWaitForManualNext,
    shouldReload,
    scanDocument,
    summarizeCourses,
    syncSelectedGroups,
  };
})(globalThis);


;(function bootstrapCourseWatcher() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (globalThis.CourseWatcherPolicy == null || globalThis.CourseWatcherRuntime == null) return;
  const controller = globalThis.CourseWatcherRuntime.createBrowserController(
    window,
    document,
    globalThis.CourseWatcherPolicy,
  );
  controller.installDialogInterceptors();

  let mounted = false;
  const mountWhenCourseTableAppears = () => {
    if (
      mounted ||
      document.body == null ||
      globalThis.CourseWatcherRuntime.findCourseTable(document) == null
    ) {
      return false;
    }
    mounted = true;
    globalThis.DLUTCourseWatcher = controller;
    controller.restore();
    return true;
  };

  if (mountWhenCourseTableAppears()) return;
  document.addEventListener?.('DOMContentLoaded', mountWhenCourseTableAppears, { once: true });
  if (window.MutationObserver != null && document.documentElement != null) {
    const observer = new window.MutationObserver(() => {
      if (mountWhenCourseTableAppears()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
