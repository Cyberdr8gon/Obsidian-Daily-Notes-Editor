import {
    Plugin,
    OpenViewState,
    TFile,
    Workspace,
    WorkspaceContainer,
    WorkspaceItem,
    WorkspaceLeaf,
    moment,
    requireApiVersion,
    TFolder,
} from "obsidian";

import { around } from "monkey-around";
import { DailyNoteEditor, isDailyNoteLeaf } from "./leafView";
import "./style/index.css";
import { addIconList } from "./utils/icon";
import {
    DailyNoteSettings,
    DailyNoteSettingTab,
    DEFAULT_SETTINGS,
} from "./dailyNoteSettings";
import { TimeField } from "./types/time";
import {
    getAllDailyNotes,
    getDailyNote,
    createDailyNote,
} from "obsidian-daily-notes-interface";
import { createUpDownNavigationExtension } from "./component/UpAndDownNavigate";
// import { setActiveEditorExt } from "./component/SetActiveEditor";
import { DAILY_NOTE_VIEW_TYPE, DailyNoteView } from "./dailyNoteView";

export default class DailyNoteViewPlugin extends Plugin {
    private view: DailyNoteView;
    lastActiveFile: TFile;
    private lastCheckedDay: string;

    settings: DailyNoteSettings;

    async onload() {
        this.addSettingTab(new DailyNoteSettingTab(this.app, this));
        await this.loadSettings();
        this.patchWorkspace();
        this.patchWorkspaceLeaf();
        addIconList();

        this.lastCheckedDay = moment().format("YYYY-MM-DD");

        // Register the up and down navigation extension
        this.settings.useArrowUpOrDownToNavigate &&
            this.registerEditorExtension([
                createUpDownNavigationExtension({
                    app: this.app,
                    plugin: this,
                }),
                // setActiveEditorExt({ app: this.app, plugin: this }),
            ]);

        this.registerView(
            DAILY_NOTE_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => (this.view = new DailyNoteView(leaf, this))
        );

        this.addRibbonIcon(
            "calendar-range",
            "Open Daily Note Editor",
            (evt: MouseEvent) => this.openDailyNoteEditor()
        );
        this.addCommand({
            id: "open-daily-note-editor",
            name: "Open Daily Note Editor",
            callback: () => this.openDailyNoteEditor(),
        });

        this.initCssRules();

        // Create daily note and open the Daily Notes Editor on startup if enabled
        if (this.settings.createAndOpenOnStartup) {
            this.app.workspace.onLayoutReady(async () => {
                // First ensure today's daily note exists
                await this.ensureTodaysDailyNoteExists();
                if (
                    this.app.workspace.getLeavesOfType(DAILY_NOTE_VIEW_TYPE)
                        .length > 0
                )
                    return;
                // Then open the Daily Notes Editor
                await this.openDailyNoteEditor();
            });
        }

        // Also check periodically (every 15 minutes) for day changes
        this.registerInterval(
            window.setInterval(this.checkDayChange.bind(this), 1000 * 60 * 15)
        );

        this.app.workspace.on("file-menu", (menu, file, source, leaf) => {
            if (file instanceof TFolder) {
                menu.addItem((item) => {
                    item.setIcon("calendar-range");
                    item.setTitle("Open daily notes for this folder");
                    item.onClick(() => {
                        this.openFolderView(file.path);
                    });
                });
            }
        });

        // === ESC Key Fix: Prevent unwanted tab switching ===
        // This fix prevents ESC key from switching to adjacent tabs when pressed in DNE editors
        // while preserving normal ESC functionality for vim mode and modal closing.
        
        this.initializeESCShield();
    }

    /**
     * Initialize ESC key fix to prevent unwanted tab switching
     * This addresses issue #46: ESC key switching to left tab
     */
    private initializeESCShield() {
        // Track focus within DNE areas for precise ESC detection
        let focusInsideDNE = false;
        this.registerDomEvent(document, "focusin", (e: FocusEvent) => {
            const target = e.target as HTMLElement | null;
            focusInsideDNE = !!target?.closest?.(".dne-root");
        });

        // Tag DNE elements for reliable detection
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                const vt = (leaf as any)?.view?.getViewType?.();
                if (vt === DAILY_NOTE_VIEW_TYPE) {
                    this.tagDNEElements((leaf as any).view);
                }
            })
        );

        // ESC key interception - skip when CodeMirror extension handles it
        const escHandler = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            
            const currentView = this.app.workspace.activeLeaf?.view?.getViewType?.();
            const target = e.target as HTMLElement;
            const isInCodeMirror = target?.closest?.(".cm-editor");
            
            // Skip if not in DNE view
            if (currentView !== DAILY_NOTE_VIEW_TYPE) return;
            
            // Allow ESC to close modals
            const modalOpen = !!document.querySelector(".modal-container,.prompt,.suggestion-container,.menu,.popover");
            if (modalOpen) return;
            
            // Let CodeMirror extension handle ESC in editors (for vim support)
            if (isInCodeMirror && this.settings.useArrowUpOrDownToNavigate) {
                return; // CodeMirror extension will handle vim mode changes
            }
            
            // Block ESC propagation to prevent unwanted tab switching
            const cameFromDNE = focusInsideDNE || target?.closest?.(".dne-root");
            if (cameFromDNE) {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();
            }
        };

        document.addEventListener("keydown", escHandler, {
            capture: true,
            passive: false
        });
        
        this.register(() => {
            document.removeEventListener("keydown", escHandler, { capture: true } as any);
        });

        // Tag DNE elements periodically for reliable detection
        this.registerInterval(window.setInterval(() => {
            this.tagDNEElements();
        }, 2000));
    }

    /**
     * Tag DNE-related DOM elements for reliable ESC event detection
     */
    private tagDNEElements(view?: any) {
        const selectors = [
            ".daily-note-editor", ".daily-note-container", ".dn-editor", 
            ".dn-leaf-view", ".cm-editor", ".cm-content"
        ];
        
        // Tag specific view elements if provided
        if (view) {
            view?.contentEl?.classList?.add?.("dne-root");
            view?.containerEl?.classList?.add?.("dne-root");
            if (view?.leaf?.containerEl) {
                view.leaf.containerEl.classList.add("dne-root");
            }
        }
        
        // Tag all DNE-related elements in the document
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach((el: Element) => {
                (el as HTMLElement).classList.add("dne-root");
            });
        });
    }

    /**
     * Patch setActiveLeaf to prevent ESC-triggered tab switching
     * This is a secondary defense layer for the ESC key fix
     */
    private patchSetActiveLeaf() {
        const originalSetActiveLeaf = this.app.workspace.setActiveLeaf.bind(this.app.workspace);
        
        this.app.workspace.setActiveLeaf = function(e: WorkspaceLeaf, t?: any) {
            const targetViewType = e?.view?.getViewType?.();
            const currentViewType = this.activeLeaf?.view?.getViewType?.();
            
            // Block unwanted switches away from DNE view
            if (currentViewType === DAILY_NOTE_VIEW_TYPE && targetViewType !== DAILY_NOTE_VIEW_TYPE) {
                // Allow legitimate switches (you can extend this logic if needed)
                const stack = new Error().stack || '';
                const isLegitimate = stack.includes('user-action') || stack.includes('click');
                
                if (!isLegitimate) {
                    return; // Block the switch
                }
            }
            
            return originalSetActiveLeaf.call(this, e, t);
        };
        
        this.register(() => {
            this.app.workspace.setActiveLeaf = originalSetActiveLeaf;
        });
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(DAILY_NOTE_VIEW_TYPE);
        document.body.toggleClass("daily-notes-hide-frontmatter", false);
        document.body.toggleClass("daily-notes-hide-backlinks", false);
    }

    async openDailyNoteEditor() {
        const workspace = this.app.workspace;
        const leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: DAILY_NOTE_VIEW_TYPE });
        workspace.revealLeaf(leaf);
    }

    async openFolderView(folderPath: string, timeField: TimeField = "mtime") {
        const workspace = this.app.workspace;
        const leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: DAILY_NOTE_VIEW_TYPE });

        // Get the view and set the selection mode to folder
        const view = leaf.view as DailyNoteView;
        view.setSelectionMode("folder", folderPath);
        view.setTimeField(timeField);

        workspace.revealLeaf(leaf);
    }

    async openTagView(tagName: string, timeField: TimeField = "mtime") {
        const workspace = this.app.workspace;
        const leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: DAILY_NOTE_VIEW_TYPE });

        // Get the view and set the selection mode to tag
        const view = leaf.view as DailyNoteView;
        view.setSelectionMode("tag", tagName);
        view.setTimeField(timeField);

        workspace.revealLeaf(leaf);
    }

    async ensureTodaysDailyNoteExists() {
        try {
            const currentDate = moment();
            const allDailyNotes = getAllDailyNotes();
            const currentDailyNote = getDailyNote(currentDate, allDailyNotes);

            if (!currentDailyNote) {
                await createDailyNote(currentDate);
            }
        } catch (error) {
            console.error("Failed to create daily note:", error);
        }
    }

    initCssRules() {
        document.body.toggleClass(
            "daily-notes-hide-frontmatter",
            this.settings.hideFrontmatter
        );
        document.body.toggleClass(
            "daily-notes-hide-backlinks",
            this.settings.hideBacklinks
        );
    }

    patchWorkspace() {
        let layoutChanging = false;
        
        // ESC Fix: Patch setActiveLeaf to prevent unwanted tab switching
        this.patchSetActiveLeaf();
        
        const uninstaller = around(Workspace.prototype, {
            getActiveViewOfType: (next: any) =>
                function (t: any) {
                    const result = next.call(this, t);
                    if (!result) {
                        if (t?.VIEW_TYPE === "markdown") {
                            const activeLeaf = this.activeLeaf;
                            if (activeLeaf?.view instanceof DailyNoteView) {
                                return activeLeaf.view.editMode;
                            } else {
                                return result;
                            }
                        }
                    }
                    return result;
                },
            changeLayout(old) {
                return async function (workspace: unknown) {
                    layoutChanging = true;
                    try {
                        // Don't consider hover popovers part of the workspace while it's changing
                        await old.call(this, workspace);
                    } finally {
                        layoutChanging = false;
                    }
                };
            },
            iterateLeaves(old) {
                type leafIterator = (item: WorkspaceLeaf) => boolean | void;
                return function (arg1, arg2) {
                    // Fast exit if desired leaf found
                    if (old.call(this, arg1, arg2)) return true;

                    // Handle old/new API parameter swap
                    const cb: leafIterator = (
                        typeof arg1 === "function" ? arg1 : arg2
                    ) as leafIterator;
                    const parent: WorkspaceItem = (
                        typeof arg1 === "function" ? arg2 : arg1
                    ) as WorkspaceItem;

                    if (!parent) return false; // <- during app startup, rootSplit can be null
                    if (layoutChanging) return false; // Don't let HEs close during workspace change

                    // 0.14.x doesn't have WorkspaceContainer; this can just be an instanceof check once 15.x is mandatory:
                    if (!requireApiVersion("0.15.0")) {
                        if (
                            parent === this.app.workspace.rootSplit ||
                            (WorkspaceContainer &&
                                parent instanceof WorkspaceContainer)
                        ) {
                            for (const popover of DailyNoteEditor.popoversForWindow(
                                (parent as WorkspaceContainer).win
                            )) {
                                // Use old API here for compat w/0.14.x
                                if (old.call(this, cb, popover.rootSplit))
                                    return true;
                            }
                        }
                    }
                    return false;
                };
            },
        });
        this.register(uninstaller);
    }

    // Used for patch workspaceleaf pinned behaviors
    patchWorkspaceLeaf() {
        this.register(
            around(WorkspaceLeaf.prototype, {
                getRoot(old) {
                    return function () {
                        const top = old.call(this);
                        return top?.getRoot === this.getRoot
                            ? top
                            : top?.getRoot();
                    };
                },
                setPinned(old) {
                    return function (pinned: boolean) {
                        old.call(this, pinned);
                        if (isDailyNoteLeaf(this) && !pinned)
                            this.setPinned(true);
                    };
                },
                openFile(old) {
                    return function (file: TFile, openState?: OpenViewState) {
                        if (isDailyNoteLeaf(this)) {
                            setTimeout(
                                around(Workspace.prototype, {
                                    recordMostRecentOpenedFile(old) {
                                        return function (_file: TFile) {
                                            // Don't update the quick switcher's recent list
                                            if (_file !== file) {
                                                return old.call(this, _file);
                                            }
                                        };
                                    },
                                }),
                                1
                            );
                            const recentFiles =
                                this.app.plugins.plugins[
                                    "recent-files-obsidian"
                                ];
                            if (recentFiles)
                                setTimeout(
                                    around(recentFiles, {
                                        shouldAddFile(old) {
                                            return function (_file: TFile) {
                                                // Don't update the Recent Files plugin
                                                return (
                                                    _file !== file &&
                                                    old.call(this, _file)
                                                );
                                            };
                                        },
                                    }),
                                    1
                                );
                        }
                        return old.call(this, file, openState);
                    };
                },
            })
        );
    }

    public async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async checkDayChange(): Promise<void> {
        const currentDay = moment().format("YYYY-MM-DD");

        if (currentDay !== this.lastCheckedDay) {
            this.lastCheckedDay = currentDay;
            console.log("Day changed, updating daily notes view");

            await this.ensureTodaysDailyNoteExists();

            const dailyNoteLeaves =
                this.app.workspace.getLeavesOfType(DAILY_NOTE_VIEW_TYPE);
            if (dailyNoteLeaves.length > 0) {
                for (const leaf of dailyNoteLeaves) {
                    const view = leaf.view as DailyNoteView;
                    if (view) {
                        view.refreshForNewDay();
                    }
                }
            }
        }
    }
}
