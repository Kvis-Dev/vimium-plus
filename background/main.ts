var Backend: BackendHandlersNS.BackendHandlers;
(function() {
  type Tab = chrome.tabs.Tab;
  type Window = chrome.windows.Window;
  interface IncNormalWnd extends Window {
    incognito: true;
    type: "normal";
  }
  interface ActiveTab extends Tab {
    active: true;
  }
  interface PopWindow extends Window {
    tabs: Tab[];
  }
  interface InfoToCreateMultiTab {
    url: string;
    active: boolean;
    windowId?: number;
    index?: number;
    openerTabId?: number;
    pinned?: boolean;
  }
  const enum UseTab { NoTab = 0, ActiveTab = 1, CurWndTabs = 2 }
  interface BgCmdNoTab {
    useTab?: UseTab.NoTab;
    (this: void): void;
  }
  interface BgCmdActiveTab {
    useTab?: UseTab.ActiveTab;
    (this: void, tabs1: [Tab] | never[]): void;
  }
  interface BgCmdCurWndTabs {
    useTab?: UseTab.CurWndTabs;
    (this: void, tabs1: Tab[]): void;
  }
  type BgCmd = BgCmdNoTab | BgCmdActiveTab | BgCmdCurWndTabs;
  interface ReopenOptions extends chrome.tabs.CreateProperties {
    id: number;
    url: string;
  }
  interface OpenUrlOptions {
    incognito?: boolean;
    position?: "start" | "end" | "before" | "after";
    opener?: boolean;
    window?: boolean;
  }
  const enum RefreshTabStep {
    start = 0,
    s1, s2, s3, s4,
    end,
  }

  function tabsCreate(args: chrome.tabs.CreateProperties, callback?: ((this: void, tab: Tab) => void) | null): 1 {
    let { url } = args, type: Urls.NewTabType | undefined;
    if (!url) {
      delete args.url;
    } else if (!(type = Settings.newTabs[url])) {}
    else if (type === Urls.NewTabType.browser) {
      delete args.url;
    } else if (type === Urls.NewTabType.vimium) {
      args.url = Settings.cache.newTabUrl_f;
    }
    return chrome.tabs.create(args, callback);
  }
  /** if count <= 1, only open once */
  function openMultiTab(this: void, option: InfoToCreateMultiTab, count: number): void {
    const wndId = option.windowId, hasIndex = option.index != null;
    tabsCreate(option, option.active ? function(tab) {
      wndId != null && tab.windowId !== wndId && funcDict.selectWnd(tab);
    } : null);
    if (count < 2) { return; }
    option.active = false;
    do {
      hasIndex && ++(option as {index: number}).index;
      chrome.tabs.create(option);
    } while(--count > 1);
  }

  const framesForTab: Frames.FramesMap = Object.create<Frames.Frames>(null),
  NoFrameId = Settings.CONST.ChromeVersion < BrowserVer.MinWithFrameId,
  funcDict = {
    isExtIdAllowed(this: void, extId: string | null | undefined): boolean {
      if (extId == null) { extId = "unknown sender"; }
      const stat = Settings.extWhiteList[extId];
      if (stat != null) { return stat; }
      console.log("%cReceive message from an extension/sender not in the white list: %c%s",
        "background-color: #fffbe5", "background-color:#fffbe5; color: red", extId);
      return Settings.extWhiteList[extId] = false;
    },
    isIncNor (this: void, wnd: Window): wnd is IncNormalWnd {
      return wnd.incognito && wnd.type === "normal";
    },
    selectFrom (this: void, tabs: Tab[]): ActiveTab {
      for (let i = tabs.length; 0 < --i; ) {
        if (tabs[i].active) {
          return tabs[i] as ActiveTab;
        }
      }
      return tabs[0] as ActiveTab;
    },
    onRefreshTab (this: void, step: RefreshTabStep, tab?: Tab): void {
      const err = chrome.runtime.lastError;
      if (err) {
        chrome.sessions.restore();
        return err;
      }
      step = step + 1;
      if (step >= RefreshTabStep.end) { return; }
      const tabId = (tab as Tab).id;
      setTimeout(function(): void {
        chrome.tabs.get(tabId, function(tab): void {
          return funcDict.onRefreshTab(step + 1, tab);
        });
      }, 50 * step * step);
    },
    setNewTabIndex (this: void, tab: Tab, pos: OpenUrlOptions["position"]): number | undefined {
      return pos === "before" ? tab.index : pos === "start" ? 0
        : pos !== "end" ? tab.index + 1 : undefined;
    },
    makeWindow (this: void, option: chrome.windows.CreateData, state?: chrome.windows.ValidStates | ""
        , callback?: ((wnd: Window) => void) | null): void {
      if (option.focused === false) {
        state !== "minimized" && (state = "normal");
      } else if (state === "minimized") {
        state = "normal";
      }
      if (state && Settings.CONST.ChromeVersion >= BrowserVer.MinCreateWndWithState) {
        option.state = state;
        state = "";
      }
      const focused = option.focused !== false;
      option.focused = true;
      chrome.windows.create(option, state || !focused ? function(wnd: Window) {
        callback && callback(wnd);
        if (!wnd) { return; } // do not return lastError: just throw errors for easier debugging
        const opt: chrome.windows.UpdateInfo = focused ? {} : { focused: false };
        state && (opt.state = state);
        chrome.windows.update(wnd.id, opt);
      } : callback || null);
    },
    makeTempWindow (this: void, tabIdUrl: number | string, incognito: boolean, callback: (wnd: Window) => void): void {
      const isId = typeof tabIdUrl === "number", option: chrome.windows.CreateData = {
        type: "normal",
        focused: false,
        incognito,
        state: "minimized",
        tabId: isId ? tabIdUrl as number : undefined,
        url: isId ? undefined : tabIdUrl as string
      };
      if (Settings.CONST.ChromeVersion < BrowserVer.MinCreateWndWithState) {
        option.state = undefined;
        option.left = option.top = 0; option.width = option.height = 50;
      }
      chrome.windows.create(option, callback);
    },
    onRuntimeError (this: void): void {
      return chrome.runtime.lastError;
    },
    safeUpdate (this: void, url: string, secondTimes?: true, tabs1?: [Tab]): void {
      if (!tabs1) {
        if (Utils.isRefusingIncognito(url) && secondTimes !== true) {
          funcDict.getCurTab(function(tabs1: [Tab]): void {
            return funcDict.safeUpdate(url, true, tabs1);
          });
          return;
        }
      } else if (tabs1.length > 0 && tabs1[0].incognito && Utils.isRefusingIncognito(url)) {
        tabsCreate({ url });
        Utils.resetRe();
        return;
      }
      const arg = { url }, cb = funcDict.onRuntimeError;
      if (tabs1) {
        chrome.tabs.update(tabs1[0].id, arg, cb);
      } else {
        chrome.tabs.update(arg, cb);
      }
      Utils.resetRe();
    },
    onEvalUrl (this: void, arr: Urls.SpecialUrl): void {
      if (arr instanceof Promise) { arr.then(funcDict.onEvalUrl); return; }
      Utils.resetRe();
      switch(arr[1]) {
      case "copy":
        return Backend.showHUD((arr as Urls.CopyEvalResult)[0], true);
      case "status":
        return Backend.forceStatus((arr as Urls.StatusEvalResult)[0]);
      }
    },
    complainNoSession(this: void): void {
      return Settings.CONST.ChromeVersion >= BrowserVer.MinSession ? Backend.complain("control tab sessions")
        : Backend.showHUD(`Vimium++ can not control tab sessions before Chrome ${BrowserVer.MinSession}`);
    },
    checkVomnibarPage: function (this: void, port: Frames.Port, nolog?: boolean): boolean {
      interface SenderEx extends Frames.Sender { isVomnibar?: boolean; warned?: boolean; }
      const info = port.sender as SenderEx;
      if (info.isVomnibar == null) {
        info.isVomnibar = info.url === Settings.cache.vomnibarPage_f || info.url === Settings.CONST.VomnibarPageInner;
      }
      if (info.isVomnibar) { return false; }
      if (!nolog && !info.warned) {
        console.warn("Receive a request from %can unsafe source page%c (should be vomnibar) :\n %s @ tab %o",
          "color:red", "color:auto", info.url, info.tabId);
        info.warned = true;
      }
      return true;
    } as {
      (this: void, port: Port, nolog: true): boolean
      (this: void, port: Frames.Port, nolog?: false): boolean
    },
    PostCompletions (this: Port, favIcon0: 0 | 1 | 2, list: Readonly<Suggestion>[]
        , autoSelect: boolean, matchType: CompletersNS.MatchType): void {
      let { url } = this.sender, favIcon = favIcon0 === 2 ? 2 : 0 as 0 | 1 | 2;
      if (favIcon0 == 1 && Settings.CONST.ChromeVersion >= BrowserVer.MinExtensionContentPageAlwaysCanShowFavIcon) {
        url = url.substring(0, url.indexOf("/", url.indexOf("://") + 3) + 1);
        const map = framesForTab;
        for (let tabId in map) {
          let frames = map[tabId] as Frames.Frames;
          for (let i = 1, len = frames.length; i < len; i++) {
            let { sender } = frames[i];
            if (sender.frameId === 0) {
              if (sender.url.startsWith(url)) { favIcon = 1; }
              break;
            }
          }
          if (favIcon) { break; }
        }
      }
      Utils.resetRe();
      try {
      this.postMessage({ name: "omni", autoSelect, matchType, list, favIcon });
      } catch (e) {}
    },
    indexFrame (this: void, tabId: number, frameId: number): Port | null {
      const ref = framesForTab[tabId];
      if (!ref) { return null; }
      for (let i = 1, len = ref.length; i < len; i++) {
        if (ref[i].sender.frameId === frameId) {
          return ref[i];
        }
      }
      return null;
    },
    confirm (this: void, command: string, count: number): boolean {
      let msg = (CommandsData.availableCommands[command] as CommandsNS.Description)[0];
      msg = msg.replace(<RegExpOne>/ \(use .*|&nbsp\(.*|<br\/>/, "");
      return confirm(
`You have asked Vimium++ to perform ${count} repeats of the command:
        ${Utils.unescapeHTML(msg)}

Are you sure you want to continue?`);
    },
    requireURL<T extends keyof FgReq> (this: void, request: FgReq[T] & BgReq["url"], ignoreHash?: true): void {
      if (Exclusions == null || Exclusions.rules.length <= 0
          || !(ignoreHash || Settings.get("exclusionListenHash", true))) {
        (request as Req.bg<"url">).name = "url";
        cPort.postMessage(request as Req.bg<"url">);
        return;
      }
      request.url = cPort.sender.url;
      return requestHandlers[request.handler as "parseUpperUrl"](request as FgReq["parseUpperUrl"], cPort) as never;
    },
    ensureInnerCSS (this: void, port: Frames.Port): string | null {
      const { sender } = port;
      if (sender.flags & Frames.Flags.hasCSS) { return null; }
      sender.flags |= Frames.Flags.hasCSSAndActed;
      return Settings.cache.innerCSS;
    },

    getCurTab: chrome.tabs.query.bind<null, { active: true, currentWindow: true }
        , (result: [Tab], _ex: FakeArg) => void, 1>(null, { active: true, currentWindow: true }),
    getCurTabs: chrome.tabs.query.bind(null, {currentWindow: true}),
    getId (this: void, tab: { readonly id: number }): number { return tab.id; },

    createTabs (this: void, rawUrl: string, count: number, active: boolean): void {
      if (!(count >= 1)) return;
      const option: chrome.tabs.CreateProperties = {url: rawUrl, active};
      tabsCreate(option);
      if (count < 2) return;
      option.active = false;
      do {
        chrome.tabs.create(option);
      } while(--count > 1);
    },
    openUrlInIncognito (this: void, url: string, active: boolean, opts: Readonly<OpenUrlOptions>, tab: Tab, wnds: Window[]): void {
      let oldWnd: Window | undefined, inCurWnd: boolean;
      oldWnd = wnds.filter(wnd => wnd.id === tab.windowId)[0];
      inCurWnd = oldWnd != null && oldWnd.incognito;
      if (!opts.window && (inCurWnd || (wnds = wnds.filter(funcDict.isIncNor)).length > 0)) {
        const options: InfoToCreateMultiTab & { windowId: number } = {
          url, active,
          windowId: inCurWnd ? tab.windowId : wnds[wnds.length - 1].id
        };
        if (inCurWnd) {
          options.index = funcDict.setNewTabIndex(tab, opts.position);
          opts.opener && (options.openerTabId = tab.id);
        }
        openMultiTab(options, commandCount);
        return !inCurWnd && active ? funcDict.selectWnd(options) : undefined;
      }
      return funcDict.makeWindow({
        url,
        incognito: true, focused: active
      }, oldWnd && oldWnd.type === "normal" ? oldWnd.state : "");
    },

    createTab: [function(url, onlyNormal, tabs): void {
      if (cOptions.url || cOptions.urls) {
        BackgroundCommands.openUrl(tabs as [Tab] | undefined);
        return chrome.runtime.lastError;
      }
      let tab: Tab | null = null;
      if (!tabs) {}
      else if (tabs.length > 0) { tab = tabs[0]; }
      else if (TabRecency.last >= 0) {
        chrome.tabs.get(TabRecency.last, function(lastTab): void {
          funcDict.createTab[0](url, onlyNormal, lastTab && [lastTab]);
        });
        return chrome.runtime.lastError;
      }
      if (!tab) {
        openMultiTab({url, active: true}, commandCount);
        return chrome.runtime.lastError;
      }
      if (tab.incognito && onlyNormal) { url = ""; }
      return openMultiTab({
        url, active: tab.active, windowId: tab.windowId,
        index: funcDict.setNewTabIndex(tab, cOptions.position)
      }, commandCount);
    }, function(wnd): void {
      if (cOptions.url || cOptions.urls) {
        return BackgroundCommands.openUrl([funcDict.selectFrom((wnd as PopWindow).tabs)]);
      }
      if (!wnd) {
        tabsCreate({url: this});
        return chrome.runtime.lastError;
      }
      const tab = funcDict.selectFrom(wnd.tabs);
      if (wnd.incognito && wnd.type !== "normal") {
        // url is disabled to be opened in a incognito window directly
        return funcDict.createTab[2](this, tab
          , commandCount > 1 ? funcDict.duplicateTab[1] : null, wnd.tabs);
      }
      return openMultiTab({
        url: this, active: tab.active, windowId: wnd.type === "normal" ? tab.windowId : undefined,
        index: funcDict.setNewTabIndex(tab, cOptions.position)
      }, commandCount);
    }, function(url, tab, repeat, allTabs): void {
      const urlLower = url.toLowerCase().split('#', 1)[0];
      allTabs = allTabs.filter(function(tab1) {
        const url = tab1.url.toLowerCase(), end = url.indexOf("#");
        return ((end < 0) ? url : url.substring(0, end)) === urlLower;
      });
      if (allTabs.length === 0) {
        chrome.windows.getAll(funcDict.createTab[3].bind(url, tab, repeat));
        return;
      }
      const tabs = allTabs.filter(tab1 => tab1.index >= tab.index);
      tab = tabs.length > 0 ? tabs[0] : allTabs[allTabs.length - 1];
      chrome.tabs.duplicate(tab.id);
      if (repeat) { return repeat(tab.id); }
    }, function(tab, repeat, wnds): void {
      wnds = wnds.filter(function(wnd) {
        return !wnd.incognito && wnd.type === "normal";
      });
      if (wnds.length > 0) {
        return funcDict.createTab[4](this, tab, repeat, wnds[0]);
      }
      return funcDict.makeTempWindow("about:blank", false, //
      funcDict.createTab[4].bind(null, this, tab, function(newTabId: number, newWndId: number): void {
        chrome.windows.remove(newWndId);
        if (repeat) { return repeat(newTabId); }
      }));
    }, function(url, tab, callback, wnd) {
      tabsCreate({
        active: false,
        windowId: wnd.id,
        url
      }, function(newTab) {
        return funcDict.makeTempWindow(newTab.id, true, funcDict.createTab[5].bind(tab, callback, newTab));
      });
    }, function(callback, newTab) {
      chrome.tabs.move(newTab.id, {
        index: this.index + 1,
        windowId: this.windowId
      }, function(): void {
        callback && callback(newTab.id, newTab.windowId);
        return funcDict.selectTab(newTab.id);
      });
    }] as [
      (this: void, url: string, onlyNormal?: boolean, tabs?: Tab[]) => void,
      (this: string, wnd?: PopWindow) => void,
      (this: void, url: string, tab: Tab, repeat: ((this: void, tabId: number) => void) | null, allTabs: Tab[]) => void,
      (this: string, tab: Tab, repeat: ((this: void, tabId: number) => void) | null, wnds: Window[]) => void,
      (this: void, url: string, tab: Tab
        , callback: ((this: void, tabId: number, wndId: number) => void) | null, wnd: Window) => void,
      (this: Tab, callback: ((this: void, tabId: number, wndId: number) => void) | null, newTab: Tab) => void
    ],
    duplicateTab: [function(tabId, wnd): void {
      const tab = wnd.tabs.filter(tab => tab.id === tabId)[0];
      return wnd.incognito && !tab.incognito ? funcDict.duplicateTab[1](tabId) : funcDict.duplicateTab[2](tab);
    }, function(id) {
      for (let count = commandCount; 0 < --count; ) {
        chrome.tabs.duplicate(id);
      }
    }, function(tab) {
      return openMultiTab({
        url: tab.url, active: false, windowId: tab.windowId,
        pinned: tab.pinned,
        index: tab.index + 2 , openerTabId: tab.id
      }, commandCount - 1);
    }] as [
      (tabId: number, wnd: PopWindow) => void,
      (tabId: number) => void,
      (tab: Tab) => void
    ],
    openUrlInNewTab (this: void, url: string, reuse: ReuseType, options: Readonly<OpenUrlOptions>, tabs: [Tab]): void {
      const tab = tabs[0], { incognito } = options, active = reuse !== ReuseType.newBg;
      let window = options.window;
      if (Utils.isRefusingIncognito(url)) {
        if (tab.incognito || TabRecency.incognito === IncognitoType.true) {
          window = true;
        }
      } else if (tab.incognito) {
        if (incognito !== false) {
          return funcDict.openUrlInIncognito(url, active, options, tab, [{ id: tab.windowId, incognito: true } as Window]);
        }
        window = true;
      } else if (incognito) {
        chrome.windows.getAll(funcDict.openUrlInIncognito.bind(null, url, active, options, tab));
        return;
      }
      if (window) {
        chrome.windows.getCurrent(function(wnd): void {
          return funcDict.makeWindow({ url, focused: active }, wnd.state);
        })
        return;
      }
      return openMultiTab({
        url, active, windowId: tab.windowId,
        openerTabId: options.opener ? tab.id : undefined,
        index: funcDict.setNewTabIndex(tab, options.position)
      }, commandCount);
    },
    openJSUrl: [function(url: string): void {
      if (!cPort) { // e.g.: use Chrome omnibox at once on starting
        chrome.tabs.update({ url }, funcDict.onRuntimeError);
        return;
      }
      const { sender } = cPort, notTop = sender.frameId > 0 || sender.tabId < 0, frameUrl = sender.url;
      if (frameUrl.startsWith("chrome")) {
        return Backend.complain("eval JavaScript on extension pages");
      }
      if (notTop || !Utils.protocolRe.test(frameUrl)) {
        return funcDict.openJSUrl[1](url);
      }
      chrome.tabs.update(sender.tabId, { url }, function(): void {
        let err = chrome.runtime.lastError;
        err && funcDict.openJSUrl[1](url);
        return err;
      });
    }, function(url: string): void {
      try { cPort.postMessage({ name: "eval", url }); } catch (e) {}
    }],
    openShowPage: [function(url, reuse, options, tab): boolean {
      const prefix = Settings.CONST.ShowPage;
      if (!url.startsWith(prefix) || url.length < prefix.length + 3) { return false; }
      if (!tab) {
        funcDict.getCurTab(function(tabs: [Tab]): void {
          if (!tabs || tabs.length <= 0) { return chrome.runtime.lastError; }
          funcDict.openShowPage[0](url, reuse, options, tabs[0]);
        });
        return true;
      }
      url = url.substring(prefix.length);
      if (reuse === ReuseType.current && !tab.incognito) {
        chrome.tabs.update(tab.id, { url: prefix });
      } else
      chrome.tabs.create({
        active: reuse !== ReuseType.newBg,
        index: tab.incognito ? undefined : funcDict.setNewTabIndex(tab, options.position),
        windowId: tab.incognito ? undefined : tab.windowId,
        openerTabId: options.opener ? tab.id : undefined,
        url: prefix
      });
      const arr: [string, ((this: void) => string) | null, number] = [url, null, 0];
      Settings.temp.shownHash = arr[1] = function(this: void): string {
        clearTimeout(arr[2]);
        Settings.temp.shownHash = null; return arr[0];
      };
      arr[2] = setTimeout(funcDict.openShowPage[1], 1200, arr);
      return true;
    }, function(arr) {
      arr[0] = "#!url vimium://error (vimium://show: sorry, the info has expired.)";
      arr[2] = setTimeout(function() {
        if (Settings.temp.shownHash === arr[1]) { Settings.temp.shownHash = null; }
        arr[0] = "", arr[1] = null;
      }, 2000);
    }] as [
      (url: string, reuse: ReuseType, options: OpenUrlOptions, tab?: Tab) => boolean,
      (arr: [string, ((this: void) => string) | null, number]) => void
    ],
    // use Urls.WorkType.Default
    openUrls: function(tabs: [Tab]): void {
      const tab = tabs[0], { windowId } = tab;
      let urls: string[] = cOptions.urls, repeat = commandCount;
      for (let i = 0; i < urls.length; i++) {
        urls[i] = Utils.convertToUrl(urls[i] + "");
      }
      tab.active = !(cOptions.reuse < ReuseType.newFg);
      cOptions = null as never;
      do {
        for (let i = 0, index = tab.index + 1, { active } = tab; i < urls.length; i++, active = false, index++) {
          tabsCreate({ url: urls[i], index, windowId, active });
        }
      } while (0 < --repeat);
    },
    moveTabToNewWindow: [function(wnd): void {
      const total = wnd.tabs.length;
      if (total <= 1) { return; } // not need to show a tip
      const tab = funcDict.selectFrom(wnd.tabs), i = tab.index, rawCount = commandCount, absCount = Math.abs(rawCount),
      limited = cOptions.limited != null ? !!cOptions.limited : absCount > total,
      count = Math.min(absCount, limited ? rawCount < 0 ? i + 1 : total - i : total);
      if (count >= total) { return Backend.showHUD("It does nothing to move all tabs of this window"); }
      if (count > 30 && !funcDict.confirm("moveTabToNewWindow", count)) { return; }
      return funcDict.makeWindow({
        tabId: tab.id,
        incognito: tab.incognito
      }, wnd.type === "normal" ? wnd.state : "",
      absCount > 1 ? funcDict.moveTabToNewWindow[1].bind(wnd, tab.index, rawCount < 0 ? -count : count) : null);
    }, function(i, count, wnd2): void {
        let tabs: Tab[] | undefined = this.tabs, tabs2: Tab[] | undefined;
        const curTab = tabs[i], len = tabs.length, end = i + count;
        if (end > len || end < -1) {
          tabs2 = count > 0 ? tabs.slice(len - count, i) : tabs.slice(i + 1, -count);
        }
        tabs = count > 0 ? tabs.slice(i + 1, end) : tabs.slice(Math.max(0, end + 1), i);
        if (this.incognito && Settings.CONST.ChromeVersion < BrowserVer.MinNoUnmatchedIncognito) {
          let {incognito} = curTab, filter = (tab: Tab): boolean => tab.incognito === incognito;
          tabs = tabs.filter(filter);
          tabs2 && (tabs2 = tabs2.filter(filter));
        }
        if (count < 0) {
          let tmp = tabs2;
          tabs2 = tabs; tabs = tmp;
        }
        let curInd = 0;
        if (tabs2 && tabs2.length > 0) {
          chrome.tabs.move(tabs2.map(funcDict.getId), {index: 0, windowId: wnd2.id}, funcDict.onRuntimeError);
          curInd = tabs2.length;
          if (curInd > 1) { // Chrome only accepts the first two tabs of tabs2
            chrome.tabs.move(curTab.id, {index: curInd});
          }
        }
        if (tabs && tabs.length > 0) {
          chrome.tabs.move(tabs.map(funcDict.getId), {index: curInd + 1, windowId: wnd2.id}, funcDict.onRuntimeError);
        }
    }] as [
      (this: void, wnd: PopWindow) => void,
      (this: PopWindow, i: number, count: number, wnd2: Window) => void
    ],
    moveTabToNextWindow: [function(tab, wnds0): void {
      let wnds: Window[], ids: number[], index = tab.windowId;
      wnds = wnds0.filter(wnd => wnd.incognito === tab.incognito && wnd.type === "normal");
      if (wnds.length > 0) {
        ids = wnds.map(funcDict.getId);
        index = ids.indexOf(index);
        if (ids.length >= 2 || index === -1) {
          let dest = (index + commandCount) % ids.length;
          index === -1 && commandCount < 0 && dest++;
          dest < 0 && (dest += ids.length);
          chrome.tabs.query({windowId: ids[dest], active: true},
          funcDict.moveTabToNextWindow[1].bind(null, tab, index));
          return;
        }
      } else {
        wnds = wnds0.filter(wnd => wnd.id === index);
      }
      return funcDict.makeWindow({
        tabId: tab.id,
        incognito: tab.incognito
      }, wnds.length === 1 && wnds[0].type === "normal" ? wnds[0].state : "");
    }, function(tab, oldIndex, tabs2): void {
      const tab2 = tabs2[0];
      if (oldIndex >= 0) {
        funcDict.moveTabToNextWindow[2](tab.id, tab2);
        return;
      }
      return funcDict.makeTempWindow(tab.id, tab.incognito, funcDict.moveTabToNextWindow[2].bind(null, tab.id, tab2));
    }, function(tabId, tab2) {
      chrome.tabs.move(tabId, {index: tab2.index + 1, windowId: tab2.windowId}, function(): void {
        return funcDict.selectTab(tabId, true);
      });
    }] as [
      (this: void, tab: Tab, wnds0: Window[]) => void,
      (tab: Tab, oldIndex: number, tabs2: [Tab]) => void,
      (tabId: number, tab2: Tab) => void
    ],
    moveTabToIncognito: [function(wnd): void {
      const tab = funcDict.selectFrom(wnd.tabs);
      if (wnd.incognito && tab.incognito) { return funcDict.moveTabToIncognito[3](); }
      const options: chrome.windows.CreateData = {tabId: tab.id, incognito: true}, url = tab.url;
      if (tab.incognito) {
      } else if (Utils.isRefusingIncognito(url)) {
        if (wnd.incognito) {
          return funcDict.moveTabToIncognito[3]();
        }
        if (Settings.CONST.ChromeVersion >= BrowserVer.MinNoUnmatchedIncognito || Settings.CONST.DisallowIncognito) {
          return Backend.complain("open this URL in incognito mode");
        }
      } else if (wnd.incognito) {
        ++tab.index;
        return Backend.reopenTab(tab);
      } else {
        options.url = url;
      }
      (wnd as Window).tabs = undefined;
      chrome.windows.getAll(funcDict.moveTabToIncognito[1].bind(null, options, wnd));
    }, function(options, wnd, wnds): void {
      let tabId: number | undefined;
      wnds = wnds.filter(funcDict.isIncNor);
      if (wnds.length) {
        chrome.tabs.query({
          windowId: wnds[wnds.length - 1].id,
          active: true
        }, funcDict.moveTabToIncognito[2].bind(null, options));
        return;
      }
      let state: chrome.windows.ValidStates | "" = wnd.type === "normal" ? wnd.state : "";
      if (options.url) {
        tabId = options.tabId;
        options.tabId = undefined;
        if (Settings.CONST.DisallowIncognito) {
          options.focused = true;
          state = "";
        }
      }
      // in tests on Chrome 46/51, Chrome hangs at once after creating a new normal window from an incognito tab
      // so there's no need to worry about stranger edge cases like "normal window + incognito tab + not allowed"
      funcDict.makeWindow(options, state);
      if (tabId != null) {
        chrome.tabs.remove(tabId);
      }
    }, function(options, tabs2): void {
      const tab2 = tabs2[0];
      if (options.url) {
        chrome.tabs.create({url: options.url, index: tab2.index + 1, windowId: tab2.windowId});
        funcDict.selectWnd(tab2);
        chrome.tabs.remove(options.tabId as number);
        return;
      }
      return funcDict.makeTempWindow(options.tabId as number, true, //
      funcDict.moveTabToNextWindow[2].bind(null, options.tabId, tab2));
    }, function(): void {
      return Backend.showHUD("This tab has been in an incognito window");
    }] as [
      (this: void, wnd: PopWindow) => void,
      (this: void, options: chrome.windows.CreateData, wnd: Window, wnds: Window[]) => void,
      (this: void, options: chrome.windows.CreateData, tabs2: [Tab]) => void,
      (this: void, ) => void
    ],
    removeTab (this: void, tab: Tab, curTabs: Tab[], wnds: Window[]): void {
      let url = false, windowId: number | undefined, wnd: Window;
      wnds = wnds.filter(wnd => wnd.type === "normal");
      if (wnds.length <= 1) {
        // protect the last window
        url = true;
        if (!(wnd = wnds[0])) {}
        else if (wnd.id !== tab.windowId) { url = false; } // the tab may be in a popup window
        else if (wnd.incognito && !Utils.isRefusingIncognito(Settings.cache.newTabUrl_f)) {
          windowId = wnd.id;
        }
        // other urls will be disabled if incognito else auto in current window
      }
      else if (!tab.incognito) {
        // protect the only "normal & not incognito" window if it has currentTab
        wnds = wnds.filter(wnd => !wnd.incognito);
        if (wnds.length === 1 && wnds[0].id === tab.windowId) {
          windowId = wnds[0].id;
          url = true;
        }
      }
      if (url) {
        const tabIds = (curTabs.length > 1) ? curTabs.map(funcDict.getId) : [tab.id];
        tabsCreate({ index: tabIds.length, url: Settings.cache.newTabUrl_f, windowId });
        chrome.tabs.remove(tabIds);
      } else {
        chrome.windows.remove(tab.windowId);
      }
    },
    restoreGivenTab (this: void, list: chrome.sessions.Session[]): void {
      if (commandCount > list.length) {
        return Backend.showHUD("The session index provided is out of range.");
      }
      const session = list[commandCount - 1], item = session.tab || session.window;
      item && chrome.sessions.restore(item.sessionId);
    },
    selectTab (this: void, tabId: number, alsoWnd?: boolean): void {
      chrome.tabs.update(tabId, {active: true}, alsoWnd ? funcDict.selectWnd : null);
    },
    selectWnd (this: void, tab?: { windowId: number }): void {
      tab && chrome.windows.update(tab.windowId, { focused: true });
      return chrome.runtime.lastError;
    },
    /** `direction` is treated as limited */
    removeTabsRelative (this: void, activeTab: {index: number, pinned: boolean}, direction: number, tabs: Tab[]): void {
      let i = activeTab.index, noPinned = false;
      if (direction > 0) {
        ++i;
        tabs = tabs.slice(i, i + direction);
      } else if (direction < 0) {
        noPinned = i > 0 && !tabs[i - 1].pinned;
        tabs = tabs.slice(Math.max(i + direction, 0), i);
      } else {
        noPinned = !activeTab.pinned && tabs.length > 1;
        tabs.splice(i, 1);
      }
      if (noPinned && tabs[0].pinned) {
        tabs = tabs.filter(tab => !tab.pinned);
      }
      if (tabs.length > 0) {
        chrome.tabs.remove(tabs.map(funcDict.getId), funcDict.onRuntimeError);
      }
    },
    focusParentFrame (this: Frames.Sender, frames: chrome.webNavigation.GetAllFrameResultDetails[]): void {
      let frameId = this.frameId, found: boolean, count = commandCount;
      do {
        found = false;
        for (let i of frames) {
          if (i.frameId === frameId) {
            frameId = i.parentFrameId;
            found = frameId > 0;
            break;
          }
        }
      } while (found && 0 < --count);
      const port = frameId > 0 ? funcDict.indexFrame(this.tabId, frameId) : null;
      if (!port) {
        return BackgroundCommands.mainFrame();
      }
      port.postMessage({
        name: "focusFrame",
        CSS: funcDict.ensureInnerCSS(port),
        key: cKey,
        mask: FrameMaskType.ForcedSelf
      });
    },
    focusOrLaunch: [function(tabs): void {
      if (tabs && tabs.length > 0) {
        chrome.windows.getCurrent(funcDict.focusOrLaunch[2].bind(this, tabs));
        return;
      }
      funcDict.getCurTab(funcDict.focusOrLaunch[1].bind(this));
      return chrome.runtime.lastError;
    }, function(tabs) {
      // if `@scroll`, then `typeof @` is `MarksNS.MarkToGo`
      const callback = this.scroll ? funcDict.focusOrLaunch[3].bind(this, 0) : null;
      if (tabs.length <= 0) {
        chrome.windows.create({url: this.url}, callback && function(wnd: Window): void {
          if (wnd.tabs && wnd.tabs.length > 0) { return callback(wnd.tabs[0]); }
        });
        return;
      }
      tabsCreate({
        index: tabs[0].index + 1,
        url: this.url,
        windowId: tabs[0].windowId
      }, callback);
    }, function(tabs, wnd): void {
      const wndId = wnd.id, url = this.url;
      let tabs2 = tabs.filter(tab => tab.windowId === wndId);
      if (tabs2.length <= 0) {
        tabs2 = tabs.filter(tab => tab.incognito === wnd.incognito);
        if (tabs2.length <= 0) {
          funcDict.getCurTab(funcDict.focusOrLaunch[1].bind(this));
          return;
        }
      }
      this.prefix && tabs2.sort((a, b) => a.url.length - b.url.length);
      let tab = tabs2[0];
      tab.active && (tab = tabs2[1] || tab);
      chrome.tabs.update(tab.id, {
        url: tab.url === url || tab.url.startsWith(url) ? undefined : url,
        active: true
      }, this.scroll ? funcDict.focusOrLaunch[3].bind(this, 0) : null);
      if (tab.windowId !== wndId) { return funcDict.selectWnd(tab); }
    }, function(this: MarksNS.MarkToGo, tick: 0 | 1 | 2, tab: Tab): void {
      if (!tab) { return chrome.runtime.lastError; }
      if (tab.status === "complete" || tick >= 2) {
        return Marks.scrollTab(this, tab);
      }
      setTimeout(() => { chrome.tabs.get(tab.id, funcDict.focusOrLaunch[3].bind(this, tick + 1)) }, 800);
    }] as [
      (this: MarksNS.FocusOrLaunch, tabs: Tab[]) => void,
      (this: MarksNS.FocusOrLaunch, tabs: [Tab] | never[]) => void,
      (this: MarksNS.FocusOrLaunch, tabs: Tab[], wnd: Window) => void,
      (this: MarksNS.MarkToGo, tick: 0 | 1 | 2, tabs: Tab | undefined) => void
    ],
    executeGlobal (cmd: string, ports: Frames.Frames | null | undefined): void {
      if (!ports) {
        return requestHandlers.cmd({ cmd, count: 1});
      }
      ports[0].postMessage({ name: "count", cmd });
    },
    toggleMuteTab: [function(tabs) {
      const tab = tabs[0];
      chrome.tabs.update(tab.id, { muted: !tab.mutedInfo.muted });
    }, function(tabs) {
      let curId = cOptions.other ? cPort.sender.tabId : GlobalConsts.TabIdNone
        , muted = false, action = { muted: true };
      for (let i = tabs.length; 0 <= --i; ) {
        const tab = tabs[i];
        if (tab.id !== curId && !tab.mutedInfo.muted) {
          muted = true;
          chrome.tabs.update(tab.id, action);
        }
      }
      if (muted) { return; }
      action.muted = false;
      for (let i = tabs.length; 0 <= --i; ) {
        const j = tabs[i].id;
        j !== curId && chrome.tabs.update(j, action);
      }
    }] as [
      (this: void, tabs: [Tab]) => void,
      (this: void, tabs: Tab[]) => void
    ]
  },
  BackgroundCommands = {
    createTab: (function (): void {}) as BgCmd,
    duplicateTab (): void {
      const tabId = cPort.sender.tabId;
      if (tabId < 0) {
        return Backend.complain("duplicate such a tab");
      }
      chrome.tabs.duplicate(tabId);
      if (commandCount < 2) { return; }
      if (Settings.CONST.ChromeVersion >= BrowserVer.MinNoUnmatchedIncognito
          || TabRecency.incognito === IncognitoType.ensuredFalse) {
        chrome.tabs.get(tabId, funcDict.duplicateTab[2]);
      } else {
        chrome.windows.getCurrent({populate: true}, funcDict.duplicateTab[0].bind(null, tabId));
      }
    },
    moveTabToNewWindow (): void {
      const incognito = !!cOptions.incognito, arr = incognito ? funcDict.moveTabToIncognito : funcDict.moveTabToNewWindow;
      if (incognito && (cPort ? cPort.sender.incognito : TabRecency.incognito === IncognitoType.true)) {
        return (arr as typeof funcDict.moveTabToIncognito)[3]();
      }
      chrome.windows.getCurrent({populate: true}, arr[0]);
    },
    moveTabToNextWindow (this: void, tabs: [Tab]): void {
      chrome.windows.getAll(funcDict.moveTabToNextWindow[0].bind(null, tabs[0]));
    },
    toggleCS (this: void, tabs: [Tab]): void {
      return ContentSettings.toggleCS(commandCount, cOptions, tabs);
    },
    clearCS (this: void): void {
      return ContentSettings.clearCS(cOptions, cPort);
    },
    goTab (this: void, tabs: Tab[]): void {
      if (tabs.length < 2) { return; }
      let count = ((cOptions.dir | 0) || 1) * commandCount, len = tabs.length, toSelect: Tab;
      count = cOptions.absolute
        ? count > 0 ? Math.min(len, count) - 1 : Math.max(0, len + count)
        : Math.abs(commandCount) > tabs.length * 2 ? (count > 0 ? -1 : 0)
        : funcDict.selectFrom(tabs).index + count;
      toSelect = tabs[(count >= 0 ? 0 : len) + (count % len)];
      if (!toSelect.active) { return funcDict.selectTab(toSelect.id); }
    },
    removeTab (this: void, tabs: Tab[]): void {
      if (!tabs || tabs.length <= 0) { return chrome.runtime.lastError; }
      const total = tabs.length, rawCount = commandCount, absCount = Math.abs(rawCount),
      limited = cOptions.limited != null ? !!cOptions.limited : absCount > total;
      let tab = tabs[0];
      if (cOptions.allow_close === true) {} else
      if (absCount >= total && (tab.active
            || !limited && (!tab.pinned || funcDict.selectFrom(tabs).pinned))
      ) {
        chrome.windows.getAll(funcDict.removeTab.bind(null, tab, tabs));
        return;
      }
      if (!tab.active) {
        tab = funcDict.selectFrom(tabs);
      }
      const i = tab.index, goLeft = cOptions.left, firstIsLeft = rawCount < 0, firstSide = firstIsLeft ? i + 1 : total - i,
      count = Math.min(absCount, limited ? firstSide : total);
      if (count > 20 && !funcDict.confirm("removeTab", count)) {
        return;
      }
      chrome.tabs.remove(tab.id, funcDict.onRuntimeError);
      if (count <= 1) {
        if (goLeft && i > 0) {
          chrome.tabs.update(tabs[i - 1].id, { active: true });
        }
        return;
      }
      const isFirstNotPinned = i > 0 && tabs[i - 1].pinned && !tab.pinned, dir = firstIsLeft ? -1 : 1;
      if (!firstIsLeft || !isFirstNotPinned) {
        funcDict.removeTabsRelative(tab, dir * (count - 1), tabs);
      }
      if (count <= firstSide || !firstIsLeft && isFirstNotPinned) {
        if (goLeft && count < firstSide && i > 0) {
          chrome.tabs.update(tabs[i - 1].id, { active: true });
        }
        return;
      }
      return funcDict.removeTabsRelative(tab, dir * (firstSide - count), tabs);
    },
    removeTabsR (this: void, tabs: Tab[]): void {
      let dir = cOptions.dir | 0;
      dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
      return funcDict.removeTabsRelative(funcDict.selectFrom(tabs), dir * commandCount, tabs);
    },
    removeRightTab (this: void, tabs: Tab[]): void {
      const last = tabs.length - 1, count = commandCount;
      if (!tabs || count > last || count < -last) { return; }
      const ind = funcDict.selectFrom(tabs).index + count;
      chrome.tabs.remove(tabs[ind > last ? last - count : ind < 0 ? -count : ind].id);
    },
    restoreTab (this: void): void {
      if (!chrome.sessions) {
        return funcDict.complainNoSession();
      }
      let count = commandCount;
      if (count < 2 && count > -2 && cPort.sender.incognito) {
        return Backend.showHUD("Can not restore a tab in incognito mode!");
      }
      const limit = (chrome.sessions.MAX_SESSION_RESULTS as number) | 0;
      count > limit && limit > 0 && (count = limit);
      do {
        chrome.sessions.restore(null, funcDict.onRuntimeError);
      } while (0 < --count);
    },
    restoreGivenTab (): void {
      if (!chrome.sessions) {
        return funcDict.complainNoSession();
      }
      if (commandCount > (chrome.sessions.MAX_SESSION_RESULTS || 25)) {
        return funcDict.restoreGivenTab([]);
      }
      if (commandCount <= 1) {
        chrome.sessions.restore(null, funcDict.onRuntimeError);
        return;
      }
      chrome.sessions.getRecentlyClosed(funcDict.restoreGivenTab);
    },
    blank (this: void): void {},
    openUrl (this: void, tabs?: [Tab] | never[]): void {
      if (cOptions.urls) {
        if (!(cOptions.urls instanceof Array)) { cOptions = null as never; return; }
        return tabs && tabs.length > 0 ? funcDict.openUrls(tabs as [Tab]) : void funcDict.getCurTab(funcDict.openUrls);
      }
      if (cOptions.url_mask && !tabs) {
        return chrome.runtime.lastError || void funcDict.getCurTab(BackgroundCommands.openUrl);
      }
      let url: Urls.Url | undefined | null, mask: string | undefined, workType: Urls.WorkType = Urls.WorkType.FakeType;
      if (url = <string>cOptions.url) {
        url = url + "";
        workType = Urls.WorkType.Default;
      } else if (cOptions.copied) {
        url = Clipboard.paste();
        if (url === null) { return Backend.complain("read clipboard"); }
        if (!(url = url.trim())) { return Backend.showHUD("No text copied!"); }
        Utils.quotedStringRe.test(url) && (url = url.slice(1, -1));
        workType = Urls.WorkType.ActAnyway;
      } else {
        url = cOptions.url_f as string || "";
      }
      if (typeof url === "string") {
        if (mask = cOptions.url_mask) {
          url = url && url.replace(mask + "", (tabs as Tab[]).length > 0 ? (tabs as [Tab])[0].url : "");
        }
        if (mask = cOptions.id_mask || cOptions.id_mark || cOptions.id_marker) {
          url = url && url.replace(mask + "", chrome.runtime.id);
        }
        if (workType !== Urls.WorkType.FakeType) {
          url = Utils.convertToUrl(url + "", cOptions.keyword + "", workType);
        }
      }
      const reuse: ReuseType = cOptions.reuse == null ? ReuseType.newFg : (cOptions.reuse | 0),
      options = cOptions as OpenUrlOptions;
      cOptions = null as never;
      Utils.resetRe();
      return typeof url !== "string" ? funcDict.onEvalUrl(url as Urls.SpecialUrl)
        : funcDict.openShowPage[0](url, reuse, options) ? void 0
        : Utils.isJSUrl(url) ? funcDict.openJSUrl[0](url)
        : reuse === ReuseType.reuse ? requestHandlers.focusOrLaunch({ url })
        : reuse === ReuseType.current ? funcDict.safeUpdate(url)
        : tabs ? funcDict.openUrlInNewTab(url, reuse, options, tabs as [Tab])
        : void funcDict.getCurTab(funcDict.openUrlInNewTab.bind(null, url, reuse, options));
        ;
    },
    searchInAnother (this: void, tabs: [Tab]): void {
      let keyword = (cOptions.keyword || "") + "";
      const query = Backend.parse({ url: tabs[0].url });
      if (!query || !keyword) {
        Backend.showHUD(keyword ? "No search engine found!"
          : 'This key mapping lacks an arg "keyword"');
        return;
      }
      let url_f = Utils.createSearchUrl(query.url.split(" "), keyword, Urls.WorkType.ActAnyway);
      cOptions = Object.setPrototypeOf({
        reuse: cOptions.reuse | 0,
        opener: true,
        url_f
      }, null);
      BackgroundCommands.openUrl(tabs);
    },
    togglePinTab (this: void, tabs: Tab[]): void {
      const tab = funcDict.selectFrom(tabs);
      let i = tab.index;
      let len = Math.max(-1, Math.min(i + commandCount, tabs.length)), dir = i < len ? 1 : -1,
      pin = !tab.pinned, action = {pinned: pin};
      if ((i < len) !== pin) { i = len - dir; len = tab.index - dir; dir = -dir; }
      do {
        chrome.tabs.update(tabs[i].id, action);
        i += dir;
      } while (len != i && i < tabs.length && i >= 0 && (pin || tabs[i].pinned));
    },
    toggleMuteTab (): void {
      if (Settings.CONST.ChromeVersion < BrowserVer.MinMuted) {
        return Backend.showHUD(`Vimium++ can not control mute state before Chrome ${BrowserVer.MinMuted}`);
      }
      if (cOptions.all || cOptions.other) {
        chrome.tabs.query({audible: true}, funcDict.toggleMuteTab[1]);
        return;
      }
      funcDict.getCurTab(funcDict.toggleMuteTab[0]);
    },
    reloadTab (this: void, tabs: Tab[] | never[]): void {
      if (tabs.length <= 0) {
        chrome.windows.getCurrent({populate: true}, function(wnd) {
          if (!wnd) { return chrome.runtime.lastError; }
          wnd.tabs.length > 0 && BackgroundCommands.reloadTab(wnd.tabs);
        });
        return;
      }
      let reloadProperties = { bypassCache: (cOptions.hard || cOptions.bypassCache) === true }
        , ind = funcDict.selectFrom(tabs).index, len = tabs.length, tail = len - 1
        , count = commandCount, dir = count > 0 ? 1 : -1, last = ind + count - dir;
      if (cOptions.single) {
        ind = last > tail ? count > len ? 0 : len - count : last < 0 ? count < -len ? tail : dir - count : last;
        last = ind + dir;
      } else if (last > tail) {
        last = len;
        count <= len && (ind = len - count);
      } else if (last < 0) {
        last = dir;
        count >= -len && (ind = dir - count);
      } else {
        last += dir;
      }
      // now `last` is the real end of iteration
      do {
        chrome.tabs.reload(tabs[ind].id, reloadProperties);
        ind += dir;
      } while (last != ind && ind < len && ind >= 0);
    },
    reloadGivenTab (): void {
      if (commandCount < 2 && commandCount > -2) {
        chrome.tabs.reload();
        return;
      }
      funcDict.getCurTabs(BackgroundCommands.reloadTab);
    },
    reopenTab (this: void, tabs: [Tab] | never[]): void {
      if (tabs.length <= 0) { return; }
      const tab = tabs[0];
      ++tab.index;
      if (Settings.CONST.ChromeVersion >= BrowserVer.MinNoUnmatchedIncognito || Settings.CONST.DisallowIncognito
          || TabRecency.incognito === IncognitoType.ensuredFalse || !Utils.isRefusingIncognito(tab.url)) {
        return Backend.reopenTab(tab);
      }
      chrome.windows.get(tab.windowId, function(wnd): void {
        if (wnd.incognito && !tab.incognito) {
          (tab as ReopenOptions).openerTabId = (tab as ReopenOptions).windowId = undefined;
        }
        return Backend.reopenTab(tab);
      });
    },
    goToRoot (this: void, tabs: [Tab]): void {
      const trail = cOptions.trailing_slash,
      { path, url } = requestHandlers.parseUpperUrl({
        trailing_slash: trail != null ? !!trail : null,
        url: tabs[0].url, upper: commandCount
      });
      if (path != null) {
        chrome.tabs.update(tabs[0].id, {url});
        return;
      }
      return Backend.showHUD(url);
    },
    goUp (this: void): void {
      const trail = cOptions.trailing_slash;
      return funcDict.requireURL({
        handler: "parseUpperUrl",
        upper: -commandCount,
        trailing_slash: trail != null ? !!trail : null,
        execute: true
      });
    },
    moveTab (this: void, tabs: Tab[]): void {
      const tab = funcDict.selectFrom(tabs), dir = cOptions.dir > 0 ? 1 : -1, pinned = tab.pinned;
      let index = Math.max(0, Math.min(tabs.length - 1, tab.index + dir * commandCount));
      while (pinned !== tabs[index].pinned) { index -= dir; }
      if (index != tab.index) {
        chrome.tabs.move(tab.id, { index });
      }
    },
    nextFrame (this: void): void {
      let port = cPort, ind = -1;
      const frames = framesForTab[port.sender.tabId];
      if (frames && frames.length > 2) {
        ind = Math.max(0, frames.indexOf(port, 1));
        for (let count = Math.abs(commandCount), dir = commandCount > 0 ? 1 : -1; count > 0; count--) {
          ind += dir;
          if (ind === frames.length) { ind = 1; }
          else if (ind < 1) { ind = frames.length - 1; }
        }
        port = frames[ind];
      }
      port.postMessage({
        name: "focusFrame",
        CSS: port.sender.frameId === 0 || !(port.sender.flags & Frames.Flags.hasCSS)
          ? funcDict.ensureInnerCSS(port) : null,
        key: cKey,
        mask: port !== cPort ? FrameMaskType.NormalNext : FrameMaskType.OnlySelf
      });
    },
    mainFrame (): void {
      const tabId = cPort ? cPort.sender.tabId : TabRecency.last, port = funcDict.indexFrame(tabId, 0);
      if (!port) { return; }
      port.postMessage({
        name: "focusFrame",
        CSS: funcDict.ensureInnerCSS(port),
        key: cKey,
        mask: (framesForTab[tabId] as Frames.Frames)[0] === port ? FrameMaskType.OnlySelf : FrameMaskType.ForcedSelf
      });
    },
    parentFrame (): void {
      const sender: Frames.Sender | undefined = cPort.sender,
      msg = NoFrameId ? `Vimium++ can not know parent frame before Chrome ${BrowserVer.MinWithFrameId}`
        : !(sender && sender.tabId >= 0 && framesForTab[sender.tabId])
          ? "Vimium++ can not access frames in current tab"
        : null;
      msg && Backend.showHUD(msg);
      if (!sender.frameId || NoFrameId || !chrome.webNavigation) {
        return BackgroundCommands.mainFrame();
      }
      chrome.webNavigation.getAllFrames({
        tabId: (sender as Frames.Sender).tabId
      }, funcDict.focusParentFrame.bind(sender as Frames.Sender));
    },
    visitPreviousTab (this: void, tabs: Tab[]): void {
      if (tabs.length < 2) { return; }
      tabs.splice(funcDict.selectFrom(tabs).index, 1);
      tabs.sort(TabRecency.rCompare);
      const tabId = tabs[commandCount > 0 ? Math.min(commandCount, tabs.length) - 1 : Math.max(0, tabs.length + commandCount)].id;
      return funcDict.selectTab(tabId);
    },
    copyTabInfo (this: void, tabs: [Tab]): void {
      let str: string, decoded = !!(cOptions.decoded || cOptions.decode);
      switch (cOptions.type) {
      case "title": str = tabs[0].title; break;
      case "frame":
        if (needIcon && (str = cPort.sender.url)) { break; }
        cPort.postMessage<1, "autoCopy">({
          name: "execute",
          CSS: funcDict.ensureInnerCSS(cPort),
          command: "autoCopy",
          count: 1,
          options: { url: true, decoded }
        });
        return;
      default: str = tabs[0].url; break;
      }
      decoded && (str = Utils.DecodeURLPart(str, decodeURI));
      Clipboard.copy(str);
      return Backend.showHUD(str, true);
    },
    goNext (): void {
      let rel: string | undefined = cOptions.rel || cOptions.dir, i: any, p2: string[] = []
        , patterns: string | string[] | boolean | number = cOptions.patterns;
      rel = rel ? rel + "" : "next";
      if (patterns instanceof Array) {
        for (i of patterns) {
          i = i && (i + "").trim();
          i && p2.push(i.toLowerCase());
        }
      } else {
        typeof patterns === "string" || (patterns = "");
        patterns = (patterns as string) || Settings.get(rel !== "next" ? "previousPatterns" : "nextPatterns", true);
        patterns = patterns.trim().toLowerCase().split(",");
        for (i of patterns) {
          i = i.trim();
          i && p2.push(i);
        }
      }
      if (p2.length > GlobalConsts.MaxNumberOfNextPatterns) { p2.length = GlobalConsts.MaxNumberOfNextPatterns; }
      cPort.postMessage<1, "goNext">({ name: "execute", count: 1, command: "goNext", CSS: null,
        options: {
          rel,
          patterns: p2
        }
      });
    },
    enterInsertMode (): void {
      let code = cOptions.code | 0, stat: KeyStat = cOptions.stat | 0, hud: boolean;
      code = stat !== KeyStat.plain ? code || VKeyCodes.esc : code === VKeyCodes.esc ? 0 : code;
      hud = cOptions.hideHud != null ? !cOptions.hideHud : !Settings.get("hideHud", true);
      cPort.postMessage<1, "enterInsertMode">({ name: "execute", count: 1, command: "enterInsertMode",
        CSS: hud ? funcDict.ensureInnerCSS(cPort) : null,
        options: {
          code, stat,
          passExitKey: !!cOptions.passExitKey,
          hud
        }
      });
    },
    performFind (): void {
      const leave = !cOptions.active,
      query = leave || cOptions.last ? (FindModeHistory as {query: FindModeQuery}).query(cPort.sender.incognito) : "";
      cPort.postMessage<1, "Find.activate">({ name: "execute", count: 1, command: "Find.activate"
          , CSS: funcDict.ensureInnerCSS(cPort), options: {
        count: cOptions.dir <= 0 ? -commandCount : commandCount,
        leave,
        query
      }});
    },
    showVomnibar (this: void, forceInner?: boolean): void {
      let port = cPort as Port | null;
      if (!port) {
        port = funcDict.indexFrame(TabRecency.last, 0);
        if (!port) { return; }
      } else if (port.sender.frameId !== 0 && port.sender.tabId >= 0) {
        port = funcDict.indexFrame(port.sender.tabId, 0) || port;
      }
      const page = Settings.cache.vomnibarPage_f, { url } = port.sender, preferWeb = !page.startsWith("chrome"),
      inner = forceInner || !page.startsWith(location.origin) ? Settings.CONST.VomnibarPageInner : page;
      forceInner = (preferWeb ? url.startsWith("chrome") || page.startsWith("file:") && !url.startsWith("file:")
          // it has occurred since Chrome 50 (BrowserVer.Min$tabs$$executeScript$hasFrameIdArg) that https refusing http iframes.
          || page.startsWith("http:") && url.startsWith("https:")
        : port.sender.incognito) || url.startsWith(location.origin) || !!forceInner;
      const useInner: boolean = forceInner || page === inner || port.sender.tabId < 0,
      options = Utils.extendIf(Object.setPrototypeOf({
        vomnibar: useInner ? inner : page,
        vomnibar2: useInner ? null : inner,
        ptype: useInner ? VomnibarNS.PageType.inner : preferWeb ? VomnibarNS.PageType.web : VomnibarNS.PageType.ext,
        script: useInner ? "" : Settings.CONST.VomnibarScript_f,
        secret: getSecret(),
        CSS: funcDict.ensureInnerCSS(cPort)
      } as CmdOptions["Vomnibar.activate"], null), cOptions as any);
      port.postMessage<1, "Vomnibar.activate">({
        name: "execute", count: commandCount, CSS: null,
        command: "Vomnibar.activate",
        options
      });
      options.secret = -1;
      cOptions = options;
    },
    clearFindHistory (this: void): void {
      const { incognito } = cPort.sender;
      FindModeHistory.removeAll(incognito);
      return Backend.showHUD((incognito ? "incognito " : "") + "find history has been cleared.");
    },
    showHelp (this: void): void {
      if (cPort.sender.frameId === 0 && !(window.HelpDialog && (cPort.sender.flags & Frames.Flags.onceHasDialog))) {
        return requestHandlers.initHelp({}, cPort);
      }
      if (!window.HelpDialog) {
        Utils.require<BaseHelpDialog>('HelpDialog');
      }
      cPort.postMessage<1, "showHelp">({
        name: "execute",
        command: "showHelp",
        count: 1,
        options: null,
        CSS: null
      });
    },
    toggleViewSource (this: void, tabs: [Tab]): void {
      let tab = tabs[0], url = tab.url;
      if (url.startsWith("chrome")) {
        return Backend.complain("visit HTML of an extension's page");
      }
      url = url.startsWith("view-source:") ? url.substring(12) : ("view-source:" + url);
      tabsCreate({
        url, active: tab.active, windowId: tab.windowId,
        index: tab.index + 1, openerTabId: tab.id
      });
    },
    clearMarks (this: void): void {
      return cOptions.local ? funcDict.requireURL({ handler: "marks", action: "clear" }, true) : Marks.clear();
    }
  },
  numHeadRe = <RegExpOne>/^-?\d+|^-/,
  executeCommand = function(command: string, registryEntry: CommandsNS.Item
      , count: number, lastKey: VKeyCodes, port: Port): void {
    const { options, repeat, alias, background } = registryEntry;
    let scale: number | undefined;
    if (options && (scale = options.count)) { count = (count * scale || 1) | 0; }
    if (count === 1) {}
    else if (repeat === 1) { count = 1; }
    else if (repeat > 0 && (count > repeat || count < -repeat) && !funcDict.confirm(command, Math.abs(count))) { return; }
    else { count = count || 1; }
    if (!background) {
      const i = alias.indexOf(".");
      command = i === 0 ? alias.substring(1) || command : alias;
      port.postMessage({ name: "execute", command, CSS: i >= 0 ? funcDict.ensureInnerCSS(port) : null, count, options });
      return;
    }
    const func: BgCmd = BackgroundCommands[alias as keyof typeof BackgroundCommands];
    cOptions = options || Object.create(null);
    cPort = port;
    commandCount = count;
    cKey = lastKey;
    count = <UseTab>func.useTab;
    if (count < UseTab.ActiveTab) {
      return (func as BgCmdNoTab)();
    } else if (count === UseTab.ActiveTab) {
      funcDict.getCurTab(func as BgCmdActiveTab);
    } else {
      funcDict.getCurTabs(func as BgCmdCurWndTabs);
    }
  },
  /**
   * type: {
   *  <K in keyof FgRes>(this: void, request: FgReq[K], port: Port): FgRes[K];
   *  <K in keyof FgReq>(this: void, request: FgReq[K], port: Port): void;
   *  [ /^A-Z/ ]: (this: void, ...args: any[]) => void;
   * }
   */
  requestHandlers = {
    blank (this: void): void {},
    setSetting (this: void, request: SetSettingReq<keyof SettingsNS.FrontUpdateAllowedSettings>, port: Port): void {
      const key = request.key;
      if (!(key in Settings.frontUpdateAllowed)) {
        cPort = port;
        return Backend.complain(`modify ${key} setting`);
      }
      Settings.set(key, request.value);
      if (key in Settings.bufferToLoad) {
        type CacheValue = SettingsNS.FullCache[keyof SettingsNS.FrontUpdateAllowedSettings];
        (Settings.bufferToLoad as SafeDict<CacheValue>)[key] = Settings.cache[key];
      }
    },
    findQuery (this: void, request: FgReq["findQuery"], port: Port): FgRes["findQuery"] | void {
      return FindModeHistory.query(port.sender.incognito, request.query, request.index);
    },
    parseSearchUrl (this: void, request: FgReq["parseSearchUrl"], port: Port): FgRes["parseSearchUrl"] | void {
      let search = Backend.parse(request);
      if ("id" in request) {
        port.postMessage({ name: "parsed", id: request.id as number, search });
      } else {
        return search;
      }
    },
    parseUpperUrl: function (this: void, request: FgReq["parseUpperUrl"], port?: Port): FgRes["parseUpperUrl"] | void {
      if (port && request.execute) {
        const result = requestHandlers.parseUpperUrl(request);
        if (result.path != null) {
          port.postMessage<1, "reload">({ name: "execute", command: "reload", count: 1, options: { url: result.url }, CSS: null });
          return;
        }
        cPort = port;
        return Backend.showHUD(result.url);
      }
      let { url } = request, url_l = url.toLowerCase();
      if (!Utils.protocolRe.test(Utils.removeComposedScheme(url_l))) {
        Utils.resetRe();
        return { url: "This url has no upper paths", path: null };
      }
      let hash = "", str: string, arr: RegExpExecArray | null, startSlash = false, endSlash = false
        , path: string | null = null, i: number, start = 0, end = 0, decoded = false, arr2: RegExpExecArray | null;
      if (i = url.lastIndexOf("#") + 1) {
        hash = url.substring(i + +(url[i] === "!"));
        str = Utils.DecodeURLPart(hash);
        i = str.lastIndexOf("/");
        if (i > 0 || (i === 0 && str.length > 1)) {
          decoded = str !== hash;
          const argRe = <RegExpOne> /([^&=]+=)([^&\/=]*\/[^&]*)/;
          arr = argRe.exec(str) || (<RegExpOne> /(^|&)([^&\/=]*\/[^&=]*)(?:&|$)/).exec(str);
          path = arr ? arr[2] : str;
          if (path === "/" || path.indexOf("://") >= 0) { path = null; }
          else if (!arr) { start = 0; }
          else if (!decoded) { start = arr.index + arr[1].length; }
          else {
            str = "https://example.com/";
            str = encodeURI(str + path).substring(str.length);
            i = hash.indexOf(str);
            if (i < 0) {
              i = hash.indexOf(str = encodeURIComponent(path));
            }
            if (i < 0) {
              decoded = false;
              i = hash.indexOf(str = path);
            }
            end = i + str.length;
            if (i < 0 && arr[1] !== "&") {
              i = hash.indexOf(str = arr[1]);
              if (i < 0) {
                decoded = true;
                str = arr[1];
                str = encodeURIComponent(str.substring(0, str.length - 1));
                i = hash.indexOf(str);
              }
              if (i >= 0) {
                i += str.length;
                end = hash.indexOf("&", i) + 1;
              }
            }
            if (i >= 0) {
              start = i;
            } else if (arr2 = argRe.exec(hash)) {
              path = Utils.DecodeURLPart(arr2[2]);
              start = arr2.index + arr2[1].length;
              end = start + arr2[2].length;
            } else if ((str = arr[1]) !== "&") {
              i = url.length - hash.length;
              hash = str + encodeURIComponent(path);
              url = url.substring(0, i) + hash;
              start = str.length;
              end = 0;
            }
          }
          if (path) {
            i = url.length - hash.length;
            start += i;
            end > 0 && (end += i);
          }
        }
      }
      if (!path) {
        if (url_l.startsWith("chrome")) {
          Utils.resetRe();
          return { url: "An extension has no upper-level pages", path: null };
        }
        hash = "";
        start = url.indexOf("/", url.indexOf("://") + 3);
        if (url_l.startsWith("filesystem:")) { start = url.indexOf("/", start + 1); }
        i = url.indexOf("?", start);
        end = url.indexOf("#", start);
        i = end < 0 ? i : i < 0 ? end : i < end ? i : end;
        i = i > 0 ? i : url.length;
        path = url.substring(start, i);
        end = 0;
        decoded = false;
      }
      i = request.upper;
      startSlash = path.startsWith("/");
      if (!hash && url_l.startsWith("file:")) {
        if (path.length <= 1 || url.length === 11 && url.endsWith(":/")) {
          Utils.resetRe();
          return { url: "This has been the root path", path: null };
        }
        endSlash = true;
        i === 1 && (i = -1);
      } else if (!hash && url_l.startsWith("ftp:")) {
        endSlash = true;
      } else {
        endSlash = request.trailing_slash != null ? !!request.trailing_slash
          : path.length > 1 && path.endsWith("/");
      }
      if (!i || i === 1) {
        path = "/";
      } else {
        const arr3 = path.substring(+startSlash, (path.length - +path.endsWith("/")) || +startSlash).split("/");
        i < 0 && (i += arr3.length);
        if (i <= 0) {
          path = "/";
        } else if (i > 0 && i < arr3.length) {
          arr3.length = i;
          path = arr3.join("/");
          path = (startSlash ? "/" : "") + path + (endSlash ? "/" : "");
        }
      }
      str = decoded ? encodeURIComponent(path) : path;
      url = url.substring(0, start) + (end ? str + url.substring(end) : str);
      Utils.resetRe();
      return { url, path };
    } as {
      (this: void, request: FgReq["parseUpperUrl"] & { execute: true }, port: Port): void;
      (this: void, request: FgReq["parseUpperUrl"], port?: Port): FgRes["parseUpperUrl"];
    },
    searchAs (this: void, request: FgReq["searchAs"], port: Port): void {
      let search = Backend.parse(request), query: string | null;
      if (!search || !search.keyword) {
        cPort = port;
        return Backend.showHUD("No search engine found!");
      }
      if (!(query = request.search.trim())) {
        query = Clipboard.paste();
        let err = query === null ? "It's not allowed to read clipboard"
          : (query = query.trim()) ? "" : "No selected or copied text found";
        if (err) {
          cPort = port;
          return Backend.showHUD(err);
        }
      }
      query = Utils.createSearchUrl((query as string).split(Utils.spacesRe), search.keyword);
      return funcDict.safeUpdate(query);
    },
    gotoSession: function (this: void, request: FgReq["gotoSession"], port?: Port): void {
      const id = request.sessionId, active = request.active !== false;
      if (typeof id === "number") {
        return funcDict.selectTab(id, true);
      }
      if (!chrome.sessions) {
        console.log("Session feature is not allowed by Chrome:", request);
        return;
      }
      chrome.sessions.restore(id, funcDict.onRuntimeError);
      if (active) { return; }
      let tabId = (port as Port).sender.tabId;
      tabId >= 0 || (tabId = TabRecency.last);
      if (tabId >= 0) { return funcDict.selectTab(tabId); }
    } as BackendHandlersNS.BackendHandlers["gotoSession"],
    openUrl (this: void, request: FgReq["openUrl"] & { url_f?: Urls.Url, opener?: boolean }, port?: Port): void {
      Object.setPrototypeOf(request, null);
      let ports: Frames.Frames | undefined, unsafe = !!port && funcDict.checkVomnibarPage(port, true);
      cPort = unsafe ? port as Port : (ports = framesForTab[port ? port.sender.tabId : TabRecency.last]) ? ports[0] : cPort;
      if (request.url) {
        let url = Utils.convertToUrl(request.url, request.keyword || null, unsafe ? Urls.WorkType.ConvertKnown : Urls.WorkType.ActAnyway);
        const type = Utils.lastUrlType;
        if (request.https != null && (type === Urls.Type.NoSchema || type === Urls.Type.NoProtocolName)) {
          url = (request.https ? "https" : "http") + (url as string).substring(4);
        } else if (unsafe && type === Urls.Type.PlainVimium && (url as string).startsWith("vimium:")) {
          url = Utils.convertToUrl(url as string);
        }
        request.url = "";
        request.keyword = "";
        request.url_f = url;
        request.opener = unsafe;
      } else {
        request.opener = false;
      }
      commandCount = 1;
      // { url_f: string, keyword: "", url: "", ... } | { copied: true, ... }
      cOptions = request as (typeof request) & SafeObject;
      return BackgroundCommands.openUrl();
    },
    focus (this: void, _0: FgReq["focus"], port: Port): void {
      let tabId = port.sender.tabId, ref = framesForTab[tabId] as Frames.WritableFrames | undefined, status: Frames.ValidStatus;
      if (!ref) {
        return needIcon ? Backend.setIcon(tabId, port.sender.status) : undefined;
      }
      if (port === ref[0]) { return; }
      if (needIcon && (status = port.sender.status) !== ref[0].sender.status) {
        ref[0] = port;
        return Backend.setIcon(tabId, status);
      }
      ref[0] = port;
    },
    checkIfEnabled: function (this: void, request: ExclusionsNS.Details | FgReq["checkIfEnabled"]
        , port?: Frames.Port | null): void {
      if (!port) {
        port = funcDict.indexFrame((request as ExclusionsNS.Details).tabId, (request as ExclusionsNS.Details).frameId);
        if (!port) { return; }
      }
      const { sender } = port, { url: oldUrl, tabId } = sender
        , pattern = Backend.getExcluded(sender.url = request.url)
        , status = pattern === null ? Frames.Status.enabled : pattern
            ? Frames.Status.partial : Frames.Status.disabled;
      if (sender.status !== status) {
        if (sender.flags & Frames.Flags.locked) { return; }
        sender.status = status;
        if (needIcon && (framesForTab[tabId] as Frames.Frames)[0] === port) {
          Backend.setIcon(tabId, status);
        }
      } else if (!pattern || pattern === Backend.getExcluded(oldUrl)) {
        return;
      }
      port.postMessage({ name: "reset", passKeys: pattern });
    } as BackendHandlersNS.checkIfEnabled,
    nextFrame (this: void, request: FgReq["nextFrame"], port: Port): void {
      cPort = port;
      commandCount = 1;
      cKey = request.key;
      const type = request.type || Frames.NextType.Default;
      if (type !== Frames.NextType.current) {
        return type === Frames.NextType.parent ? BackgroundCommands.parentFrame() : BackgroundCommands.nextFrame();
      }
      const ports = framesForTab[port.sender.tabId];
      if (ports) {
        ports[0].postMessage({
          name: "focusFrame",
          key: cKey,
          mask: FrameMaskType.NoMask
        });
        return;
      }
      try { port.postMessage({ name: "returnFocus", key: cKey }); } catch (e) {}
    },
    exitGrab (this: void, _0: FgReq["exitGrab"], port: Port): void {
      const ports = framesForTab[port.sender.tabId];
      if (!ports) { return; }
      ports[0].sender.flags |= Frames.Flags.userActed;
      if (ports.length < 3) { return; }
      for (let msg = { name: "exitGrab" as "exitGrab" }, i = ports.length; 0 < --i; ) {
        const p = ports[i];
        if (p !== port) {
          p.postMessage(msg);
          p.sender.flags |= Frames.Flags.userActed;
        }
      }
    },
    execInChild (this: void, request: FgReq["execInChild"], port: Port): FgRes["execInChild"] {
      const ports = framesForTab[port.sender.tabId], url = request.url;
      if (!ports || ports.length < 3) { return false; }
      let iport: Port | null = null, i = ports.length;
      while (1 <= --i) {
        if (ports[i].sender.url === url) {
          if (iport) { return false; }
          iport = ports[i];
        }
      }
      if (iport) {
        iport.postMessage({
          CSS: request.CSS ? funcDict.ensureInnerCSS(iport) : null,
          name: "execute", command: request.command, count: request.count || 1, options: request.options
        });
        return true;
      }
      return false;
    },
    initHelp (this: void, request: FgReq["initHelp"], port: Port): void {
      Promise.all([
        Utils.require<BaseHelpDialog>('HelpDialog'),
        request, port,
        new Promise<void>(function(resolve, reject) {
          const xhr = Settings.fetchFile("helpDialog", resolve);
          xhr instanceof XMLHttpRequest && (xhr.onerror = reject);
        })
      ]).then(function(args): void {
        const port = args[1].wantTop && funcDict.indexFrame(args[2].sender.tabId, 0) || args[2];
        (port.sender as Frames.Sender).flags |= Frames.Flags.onceHasDialog;
        port.postMessage({
          name: "showHelpDialog",
          CSS: funcDict.ensureInnerCSS(port),
          html: args[0].render(args[1]),
          optionUrl: Settings.CONST.OptionsPage,
          advanced: Settings.get("showAdvancedCommands", true)
        });
      }, function(args): void {
        console.error("Promises for initHelp failed:", args[0], ';', args[3]);
      });
    },
    css (this: void, _0: {}, port: Port): void {
      const CSS = funcDict.ensureInnerCSS(port);
      if (CSS) {
        port.postMessage({ name: "showHUD", CSS });
      }
    },
    activateVomnibar (this: void, request: FgReq["activateVomnibar"] & Req.baseFg<string>, port: Port): void {
      const { count, inner } = request;
      if (count != null) {
        delete request.count, delete request.handler, delete request.inner;
        commandCount = +count || 1;
        cOptions = Object.setPrototypeOf(request, null);
      } else if (request.redo !== true) {
        return;
      } else if (cOptions == null || cOptions.secret !== -1) {
        if (inner) { return; }
        cOptions = Object.create(null);
        commandCount = 1;
      } else if (inner && (cOptions as any as CmdOptions["Vomnibar.activate"]).vomnibar === Settings.CONST.VomnibarPageInner) {
        return;
      }
      cPort = port;
      return BackgroundCommands.showVomnibar(inner);
    },
    omni (this: void, request: FgReq["omni"], port: Port): void {
      if (funcDict.checkVomnibarPage(port)) { return; }
      return Completers.filter(request.query, request, funcDict.PostCompletions.bind(port
        , (<number>request.favIcon | 0) as number as 0 | 1 | 2));
    },
    copy (this: void, request: FgReq["copy"]): void {
      return Clipboard.copy(request.data);
    },
    key (this: void, request: FgReq["key"], port: Port): void {
      let key: string = request.key, count = 1;
      let arr: null | string[] = numHeadRe.exec(key);
      if (arr != null) {
        let prefix = arr[0];
        key = key.substring(prefix.length);
        count = prefix !== "-" ? parseInt(prefix, 10) || 1 : -1;
      }
      const ref = CommandsData.keyToCommandRegistry;
      if (!(key in ref)) {
        arr = key.match(Utils.keyRe) as string[];
        key = arr[arr.length - 1];
        count = 1;
      }
      const registryEntry = ref[key] as CommandsNS.Item;
      Utils.resetRe();
      return executeCommand(registryEntry.command, registryEntry, count, request.lastKey, port);
    },
    marks (this: void, request: FgReq["marks"], port: Port): void {
      cPort = port;
      switch (request.action) {
      case "create": return Marks.createMark(request, port);
      case "goto": return Marks.gotoMark(request, port);
      case "clear": return Marks.clear(request.url);
      default: return;
      }
    },
    focusOrLaunch (this: void, request: MarksNS.FocusOrLaunch, _port?: Port | null, notFolder?: true): void {
      // * do not limit windowId or windowType
      let url = Utils.reformatURL(request.url.split("#", 1)[0]), callback = funcDict.focusOrLaunch[0];
      if (url.startsWith("file:") && !notFolder && url.substring(url.lastIndexOf("/") + 1).indexOf(".") < 0) {
        chrome.tabs.query({ url: url + "/" }, function(tabs): void {
          return tabs && tabs.length > 0 ? callback.call(request, tabs) : requestHandlers.focusOrLaunch(request, null, true);
        });
        return;
      }
      chrome.tabs.query({
        url: request.prefix ? url + "*" : url
      }, callback.bind(request));
    },
    cmd (this: void, request: FgReq["cmd"]): void {
      const cmd = request.cmd;
      Backend.execute(cmd, CommandsData.cmdMap[cmd] || null, request.count);
    },
    blurTest (this: void, _0: FgReq["blurTest"], port: Port): void {
      if (port.sender.tabId < 0) {
        port.postMessage({ name: "blurred" });
        return;
      }
      setTimeout(function(): void {
        if (port.sender.tabId === TabRecency.last && Connections.framesForOmni.indexOf(port) >= 0) {
          port.postMessage({ name: "blurred" });
        }
      }, 50);
    }
  },
  Connections = {
    state: 0,
    _fakeId: GlobalConsts.MaxImpossibleTabId as number,
    framesForOmni: [null as never] as Frames.WritableFrames,
    OnMessage (this: void, request: Req.baseFg<string> | Req.baseFgWithRes<string>, port: Frames.Port): void {
      let id: number | undefined;
      if (id = (request as Req.baseFgWithRes<string>)._msgId) {
        request = (request as Req.baseFgWithRes<string>).request;
        port.postMessage<"findQuery">({
          _msgId: id,
          response: requestHandlers[(request as Req.baseFg<string>).handler as
            "findQuery"](request as Req.fg<"findQuery">, port) as FgRes["findQuery"]
        });
      } else {
        return requestHandlers[(request as Req.baseFg<string>).handler as "key"](request as Req.fg<"key">, port);
      }
    },
    OnConnect (this: void, port: Frames.Port): void {
      const type = (port.name.substring(9) as string | number as number) | 0,
      sender = Connections.format(port), { tabId, url } = sender;
      let status: Frames.ValidStatus, ref = framesForTab[tabId] as Frames.WritableFrames | undefined;
      if (type >= PortType.omnibar || (url === Settings.cache.vomnibarPage_f)) {
        if (type < PortType.knownStatusBase) {
          if (Connections.onOmniConnect(port, tabId, type)) {
            return;
          }
          status = Frames.Status.enabled;
          sender.flags = Frames.Flags.userActed;
        } else {
          status = ((type >>> PortType.BitOffsetOfKnownStatus) & PortType.MaskOfKnownStatus) - 1;
          sender.flags = ((type & PortType.isLocked) ? Frames.Flags.lockedAndUserActed : Frames.Flags.userActed
            ) + ((type & PortType.hasCSS) && Frames.Flags.hasCSS);
        }
      } else {
        let pass: null | string, flags: Frames.Flags = Frames.Flags.blank;
        if (ref && ((flags = sender.flags = ref[0].sender.flags & Frames.Flags.InheritedFlags) & Frames.Flags.locked)) {
          status = ref[0].sender.status;
          pass = status !== Frames.Status.disabled ? null : "";
        } else {
          pass = Backend.getExcluded(url);
          status = pass === null ? Frames.Status.enabled : pass ? Frames.Status.partial : Frames.Status.disabled;
        }
        port.postMessage({
          name: "init",
          flags,
          load: Settings.bufferToLoad,
          passKeys: pass,
          mapKeys: CommandsData.mapKeyRegistry,
          keyMap: CommandsData.keyMap
        });
      }
      sender.status = status;
      port.onDisconnect.addListener(Connections.OnDisconnect);
      port.onMessage.addListener(Connections.OnMessage);
      if (ref) {
        ref.push(port);
        if (type & PortType.hasFocus) {
          if (needIcon && ref[0].sender.status !== status) {
            Backend.setIcon(tabId, status);
          }
          ref[0] = port;
        }
      } else {
        framesForTab[tabId] = [port, port];
        status !== Frames.Status.enabled && needIcon && Backend.setIcon(tabId, status);
      }
      if (NoFrameId) {
        (sender as any).frameId = (type & PortType.isTop) ? 0 : ((Math.random() * 9999997) | 0) + 2;
      }
    },
    OnDisconnect (this: void, port: Port): void {
      let { tabId } = port.sender, i: number, ref = framesForTab[tabId] as Frames.WritableFrames | undefined;
      if (!ref) { return; }
      i = ref.lastIndexOf(port);
      if (!port.sender.frameId) {
        if (i >= 0) {
          delete framesForTab[tabId];
        }
        return;
      }
      if (i === ref.length - 1) {
        --ref.length;
      } else if (i >= 1) {
        ref.splice(i, 1);
      }
      if (ref.length <= 1) {
        delete framesForTab[tabId];
        return;
      }
      if (port === ref[0]) {
        ref[0] = ref[1];
      }
    },
    onOmniConnect (port: Frames.Port, tabId: number, type: PortType): boolean {
      if (type >= PortType.omnibar) {
        if (!funcDict.checkVomnibarPage(port)) {
          this.framesForOmni.push(port);
          if (tabId < 0) {
            (port.sender as Frames.RawSender).tabId = type !== PortType.omnibar ? this._fakeId--
               : cPort ? cPort.sender.tabId : TabRecency.last;
          }
          port.onDisconnect.addListener(this.OnOmniDisconnect);
          port.onMessage.addListener(this.OnMessage);
          port.postMessage({
            name: "secret",
            browserVersion: Settings.CONST.ChromeVersion,
            secret: getSecret()
          });
          return true;
        }
      } else if (tabId < 0 // should not be true; just in case of misusing
        || Settings.CONST.ChromeVersion < BrowserVer.Min$tabs$$executeScript$hasFrameIdArg
        || port.sender.frameId === 0
        ) {
      } else {
        chrome.tabs.executeScript(tabId, {
          file: Settings.CONST.VomnibarScript,
          frameId: port.sender.frameId,
          runAt: "document_start"
        });
        port.disconnect();
        return true;
      }
      return false;
    },
    OnOmniDisconnect (this: void, port: Port): void {
      const ref = Connections.framesForOmni, i = ref.lastIndexOf(port);
      if (i === ref.length - 1) {
        --ref.length;
      } else if (i >= 0) {
        ref.splice(i, 1);
      }
    },
    format (port: Frames.RawPort): Frames.Sender {
      const sender = port.sender, tab = sender.tab || {
        id: this._fakeId--,
        incognito: false
      };
      return port.sender = {
        frameId: sender.frameId || 0,
        incognito: tab.incognito,
        status: Frames.Status.enabled,
        flags: Frames.Flags.blank,
        tabId: tab.id,
        url: sender.url
      };
    }
  };
  
  Backend = {
    gotoSession: requestHandlers.gotoSession,
    openUrl: requestHandlers.openUrl,
    checkIfEnabled: requestHandlers.checkIfEnabled,
    focus: requestHandlers.focusOrLaunch,
    getExcluded: Utils.getNull,
    IconBuffer: null,
    setIcon (): void {},
    complain (action: string): void {
      return this.showHUD("It's not allowed to " + action);
    },
    parse (this: void, request: FgReq["parseSearchUrl"]): FgRes["parseSearchUrl"] {
      let s0 = request.url, url = s0.toLowerCase(), pattern: Search.Rule | undefined
        , arr: string[] | null = null, _i: number, selectLast = false;
      if (!Utils.protocolRe.test(Utils.removeComposedScheme(url))) {
        Utils.resetRe();
        return null;
      }
      if (request.upper) {
        const obj = requestHandlers.parseUpperUrl(request as FgReq["parseUpperUrl"]);
        obj.path != null && (s0 = obj.url);
        return { keyword: '', start: 0, url: s0 };
      }
      const decoders = Settings.cache.searchEngineRules;
      if (_i = Utils.IsURLHttp(url)) {
        url = url.substring(_i);
        s0 = s0.substring(_i);
      }
      for (_i = decoders.length; 0 <= --_i; ) {
        pattern = decoders[_i];
        if (!url.startsWith(pattern.prefix)) { continue; }
        arr = s0.substring(pattern.prefix.length).match(pattern.matcher);
        if (arr) { break; }
      }
      if (!arr || !pattern) { Utils.resetRe(); return null; }
      if (arr.length > 1 && !pattern.matcher.global) { arr.shift(); }
      const re = pattern.delimiter;
      if (arr.length > 1) {
        selectLast = true;
      } else if (re instanceof RegExp) {
        url = arr[0];
        if (arr = url.match(re)) {
          arr.shift();
          selectLast = true;
        } else {
          arr = [url];
        }
      } else {
        arr = arr[0].split(re);
      }
      url = "";
      for (_i = 0; _i < arr.length; _i++) { url += " " + Utils.DecodeURLPart(arr[_i]); }
      url = url.trim().replace(Utils.spacesRe, " ");
      Utils.resetRe();
      return {
        keyword: pattern.name,
        url,
        start: selectLast ? url.lastIndexOf(" ") + 1 : 0
      };
    },
    reopenTab (this: void, tab: Tab, refresh?: boolean): void {
      if (refresh) {
        chrome.tabs.remove(tab.id, funcDict.onRuntimeError);
        chrome.tabs.get(tab.id, funcDict.onRefreshTab.bind(null, RefreshTabStep.start));
        return;
      }
      tabsCreate({
        windowId: tab.windowId,
        index: tab.index,
        url: tab.url,
        active: tab.active,
        pinned: tab.pinned,
        openerTabId: tab.openerTabId,
      });
      chrome.tabs.remove(tab.id);
      // not seems to need to restore muted status
    },
    showHUD (message: string, isCopy?: boolean): void {
      try {
        cPort && cPort.postMessage({
          name: "showHUD",
          CSS: funcDict.ensureInnerCSS(cPort),
          text: message,
          isCopy: isCopy === true
        });
      } catch (e) {
        cPort = null as never;
      }
    },
    forceStatus (act: Frames.ForcedStatusText, tabId?: number): void {
      const ref = framesForTab[tabId || (tabId = TabRecency.last)];
      if (!ref) { return; }
      act = act.toLowerCase() as Frames.ForcedStatusText;
      const always_enabled = Exclusions == null || Exclusions.rules.length <= 0, oldStatus = ref[0].sender.status,
      stat = act === "enable" ? Frames.Status.enabled : act === "disable" ? Frames.Status.disabled
        : act === "toggle" ? oldStatus === Frames.Status.disabled ? Frames.Status.enabled : Frames.Status.disabled
        : null,
      locked = stat !== null, unknown = !(locked || always_enabled),
      msg: Req.bg<"reset"> = { name: "reset", passKeys: stat !== Frames.Status.disabled ? null : "", forced: locked };
      cPort = funcDict.indexFrame(tabId, 0) || ref[0];
      if (stat == null && tabId < 0) {
        oldStatus !== Frames.Status.disabled && this.showHUD("Got an unknown action on status: " + act);
        return;
      }
      let pattern: string | null, newStatus = locked ? stat as Frames.ValidStatus : Frames.Status.enabled;
      for (let i = ref.length; 1 <= --i; ) {
        const port = ref[i], sender = port.sender;
        sender.flags = locked ? sender.flags | Frames.Flags.locked : sender.flags & ~Frames.Flags.locked;
        if (unknown) {
          pattern = msg.passKeys = this.getExcluded(sender.url);
          newStatus = pattern === null ? Frames.Status.enabled : pattern
            ? Frames.Status.partial : Frames.Status.disabled;
          if (newStatus !== Frames.Status.partial && sender.status === newStatus) { continue; }
        }
        // must send "reset" messages even if port keeps enabled by 'v.st enable' - frontend may need to reinstall listeners
        sender.status = newStatus;
        port.postMessage(msg);
      }
      newStatus !== Frames.Status.disabled && this.showHUD("Now the page status is " + (
        newStatus === Frames.Status.enabled ? "enabled" : "partially disabled" ));
      if (needIcon && (newStatus = ref[0].sender.status) !== oldStatus) {
        return this.setIcon(tabId, newStatus);
      }
    },
    execute (this: void, command, options, count, lastKey): void {
      count = (count as number) | 0;
      options && typeof options === "object" ?
          Object.setPrototypeOf(options, null) : (options = null);
      lastKey = (+<number>lastKey || VKeyCodes.None) as VKeyCodes;
      return executeCommand(command, Utils.makeCommand(command, options), count, lastKey, null as never as Port);
    },
    ExecuteGlobal (this: void, cmd: string): void {
      const tabId = TabRecency.last, ports = framesForTab[tabId];
      if (cmd === "quickNext") { cmd = "nextTab"; }
      if (ports == null || (ports[0].sender.flags & Frames.Flags.userActed)) {
        return funcDict.executeGlobal(cmd, ports);
      }
      chrome.tabs.get(tabId, function(tab): void {
        funcDict.executeGlobal(cmd, tab && tab.status === "complete" ? framesForTab[tab.id] : null);
        return chrome.runtime.lastError;
      });
    },
    indexPorts: function (tabId?: number, frameId?: number): Frames.FramesMap | Frames.Frames | Port | null {
      return tabId == null ? framesForTab : frameId == null ? (framesForTab[tabId] || null)
        : funcDict.indexFrame(tabId, frameId);
    } as BackendHandlersNS.BackendHandlers["indexPorts"],
  Init(): void {
    if (3 !== ++Connections.state) { return; }
    Backend.Init = null;
    Utils.resetRe();
    chrome.runtime.onConnect.addListener(Connections.OnConnect);
    if (!chrome.runtime.onConnectExternal) { return; }
    Settings.extWhiteList || Settings.postUpdate("extWhiteList");
    chrome.runtime.onConnectExternal.addListener(function(port): void {
      if (port.sender && funcDict.isExtIdAllowed(port.sender.id)
          && port.name.startsWith("vimium++")) {
        return Connections.OnConnect(port as Frames.RawPort as Frames.Port);
      } else {
        port.disconnect();
      }
    });
  }
  };

  /** any change to `commandCount` should ensure it won't be `0` */
  let cOptions: CommandsNS.Options = null as never, cPort: Frames.Port = null as never, commandCount: number = 1,
  needIcon = false, cKey: VKeyCodes = VKeyCodes.None,
  getSecret = function(this: void): number {
    let secret = 0, time = 0;
    getSecret = function(this: void): number {
      const now = Date.now();
      if (now - time > GlobalConsts.VomnibarSecretTimeout) {
        secret = 1 + (0 | (Math.random() * 0x6fffffff));
      }
      time = now;
      return secret;
    };
    return getSecret();
  };

  if (Settings.CONST.ChromeVersion >= BrowserVer.MinNoUnmatchedIncognito) {
    funcDict.createTab.length = 1;
  }
  Settings.updateHooks.newTabUrl_f = function(url) {
    const onlyNormal = Utils.isRefusingIncognito(url), mayForceIncognito = funcDict.createTab.length > 1 && onlyNormal;
    BackgroundCommands.createTab = mayForceIncognito ? function(): void {
      chrome.windows.getCurrent({populate: true}, funcDict.createTab[1].bind(url));
    } : funcDict.createTab[0].bind(null, url, onlyNormal);
    BackgroundCommands.createTab.useTab = mayForceIncognito ? UseTab.NoTab : UseTab.ActiveTab;
  };

  Settings.updateHooks.showActionIcon = function (value) {
    needIcon = value && chrome.browserAction ? true : false;
  };

  chrome.runtime.onMessageExternal && (chrome.runtime.onMessageExternal.addListener(function(this: void, message, sender, sendResponse): void {
    let command: string | undefined;
    if (!funcDict.isExtIdAllowed(sender.id)) {
      sendResponse(false);
      return;
    }
    if (typeof message === "string") {
      command = message;
      if (command && CommandsData.availableCommands[command]) {
        return Backend.execute(command);
      }
      return;
    }
    if (typeof message !== "object") { return; }
    switch (message.handler) {
    case "command":
      command = message.command ? message.command + "" : "";
      if (!(command && CommandsData.availableCommands[command])) { return; }
      return Backend.execute(command, message.options, message.count, message.key);
    case "content_scripts":
      sendResponse(Settings.CONST.ContentScripts);
      return;
    }
  }), Settings.postUpdate("extWhiteList"));

  chrome.tabs.onReplaced && chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
    const ref = framesForTab, frames = ref[removedTabId];
    if (!frames) { return; }
    delete ref[removedTabId];
    ref[addedTabId] = frames;
    for (let i = frames.length; 0 < --i; ) {
      (frames[i].sender as Frames.RawSender).tabId = addedTabId;
    }
  });

  setTimeout(function(): void {
    Settings.postUpdate("bufferToLoad", null);
    return (Backend.Init as (this: void) => void)();
  }, 0);

  (function(): void {
    type Keys = keyof typeof BackgroundCommands;
    let ref: Keys[], i: Keys, ref2 = BackgroundCommands, key: Keys;
    for (key in ref2) { (ref2[key] as BgCmd).useTab = UseTab.NoTab; }

    ref = ["goTab", "moveTab", "reloadTab", "removeRightTab" //
      , "removeTab", "removeTabsR", "togglePinTab", "visitPreviousTab" //
    ];
    for (i of ref) { (ref2[i] as BgCmdCurWndTabs).useTab = UseTab.CurWndTabs; }
    ref = ["copyTabInfo", "goToRoot", "moveTabToNextWindow"//
      , "reopenTab", "toggleCS", "toggleViewSource" //
      , "searchInAnother" //
    ];
    for (i of ref) { (ref2[i] as BgCmdActiveTab).useTab = UseTab.ActiveTab; }
  })();

  setTimeout(function(): void {
    Settings.fetchFile("baseCSS");
    Settings.postUpdate("searchUrl", null); // will also update newTabUrl
    Settings.postUpdate("vomnibarPage");

    (document.documentElement as HTMLHtmlElement).textContent = '';
    (document.firstChild as DocumentType).remove();
    Utils.resetRe();
  }, 34);

  // will run only on <F5>, not on runtime.reload
  window.onunload = function(event): void {
    if (event && event.isTrusted == false) { return; }
    let ref = framesForTab as Frames.FramesMapToDestroy, tabId: string;
    ref.omni = Connections.framesForOmni;
    for (tabId in ref) {
      let arr = ref[tabId], end = arr.length;
      for (let i = 1; i < end; i++) {
        arr[i].disconnect();
      }
    }
  };
})();
