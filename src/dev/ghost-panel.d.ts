/**
 * Minimal ambient types for the vendored `ghost-panel` package (plain JS,
 * ships no declarations). Only the surface `src/dev/` actually uses is
 * typed; everything else stays off the record on purpose so we notice when
 * we start depending on more of the API.
 *
 * Sources of truth: node_modules/ghost-panel/index.js (createGhostPanel,
 * ui object), folder.js (control factories), skills.js (SkillsRegistry +
 * attachSkillsAPI).
 */
declare module 'ghost-panel' {
  export interface GhostControlHandle {
    element: HTMLElement;
    setValue?(value: unknown): void;
    /** Info controls (createInfo) expose setText. */
    setText?(text: string): void;
    setColor?(color: string): void;
  }

  export interface GhostSliderOptions {
    min?: number;
    max?: number;
    step?: number;
    value?: number;
    suffix?: string;
    id?: string;
    tooltip?: string;
    onChange?: (value: number) => void;
    read?: () => number;
  }

  export interface GhostCheckboxOptions {
    value?: boolean;
    id?: string;
    tooltip?: string;
    onChange?: (value: boolean) => void;
  }

  export interface GhostSelectOptions {
    options?: string[];
    value?: string;
    id?: string;
    tooltip?: string;
    onChange?: (value: string) => void;
  }

  /** createColor (controls.js): swatch + popover picker; value/onChange
   * carry hex strings like '#aabbcc'. */
  export interface GhostColorOptions {
    value?: string;
    id?: string;
    tooltip?: string;
    onChange?: (value: string) => void;
  }

  export interface GhostButtonRowEntry {
    label: string;
    onClick: () => void;
    tooltip?: string;
  }

  export interface GhostFolder {
    addSlider(label: string, opts?: GhostSliderOptions): GhostFolder;
    addCheckbox(label: string, opts?: GhostCheckboxOptions): GhostFolder;
    addSelect(label: string, opts?: GhostSelectOptions): GhostFolder;
    addColor(label: string, opts?: GhostColorOptions): GhostFolder;
    addButton(label: string, onClick: () => void): GhostFolder;
    /** Returns the button-row handle, not the folder (see folder.js). */
    addButtonRow(buttons: GhostButtonRowEntry[]): unknown;
    addInfo(text: string, id?: string): GhostFolder;
    get(id: string): GhostControlHandle | undefined;
    collapse(): void;
    expand(): void;
  }

  /** ctx handed to skill detect/apply — whatever createGhostPanel received. */
  export type GhostSkillContext = Record<string, unknown>;

  export interface GhostSkillDefinition {
    id: string;
    name: string;
    category?: string;
    workflows?: string[];
    description?: string;
    properties?: { id: string; type: string; [key: string]: unknown }[];
    detect?(ctx: GhostSkillContext): boolean;
    apply(ui: GhostPanelUi, ctx: GhostSkillContext): unknown;
    teardown?(ui: GhostPanelUi, handle: unknown): void;
  }

  export interface GhostSkillsApi {
    register(skill: GhostSkillDefinition): GhostSkillDefinition;
    apply(id: string): Promise<unknown>;
    remove(id: string): void;
    describe(opts?: { includeProperties?: boolean }): unknown;
    registry: { unregister(id: string): void };
  }

  /** SceneObjectManager (three-extensions.js): the outliner's registry.
   * register triggers the outliner refresh; remove also detaches the object
   * from its parent, so only call it for nodes already out of the scene. */
  export interface GhostObjectManager {
    register(name: string, object: unknown): void;
    remove(name: string): void;
    getNames(): string[];
    objects: Record<string, { object?: unknown } | undefined>;
    /** Primary (most recent) selection, or null. */
    activeName?: string | null;
    select(name: string, opts?: { additive?: boolean }): void;
    deselect(): void;
    /** 'change' fires on select/deselect/rename and during gizmo drags. */
    on(event: 'change' | 'register' | 'remove' | 'rename', cb: (name: string | null, object: unknown) => void): void;
  }

  export interface GhostPanelUi {
    panel: { removeFolder(name: string): void; title: string };
    scenePanel: unknown;
    objectManager?: GhostObjectManager;
    addFolder(name: string, opts?: { collapsed?: boolean }): GhostFolder;
    getFolder(name: string): GhostFolder | undefined;
    show(): void;
    hide(): void;
    toggle(): void;
    isVisible(): boolean;
    bindToggleKey(
      key: string,
      mods?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean },
    ): void;
    skills: GhostSkillsApi;
    update(): void;
    dispose(): void;
  }

  export interface GhostPanelOptions {
    title?: string;
    width?: number;
    visible?: boolean;
    theme?: string;
    scene?: unknown;
    camera?: unknown;
    renderer?: unknown;
    controls?: unknown;
    gizmo?: boolean;
    scenePanel?: boolean;
  scenePanelTitle?: string;
    materialsPanel?: boolean;
    autoRegister?: boolean;
    saveLoad?: boolean;
    workflow?: string | string[];
    workflowPicker?: boolean | string;
    diagnostics?: boolean;
    augment?: boolean;
    /** Per-object gizmo routing: return false to keep the built-in
     * transform gizmo off this object (three-extensions.js select()). */
    beforeGizmoAttach?(obj: unknown): boolean | void;
    /** Fires when the built-in gizmo starts/stops dragging. */
    onDraggingChanged?(dragging: boolean): void;
  }

  export function createGhostPanel(opts?: GhostPanelOptions): GhostPanelUi;
}
