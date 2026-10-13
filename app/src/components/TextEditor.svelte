<script lang="ts">
  // Input for Markdown text (description, comment, create dialog). Shows the editor
  // (lib/editor/RichEditor.svelte) once it is loaded; until then a textarea that already works
  // (typing, images). The switch carries over text and focus. Images still uploading land in
  // whichever field is current through `proxy`.
  import type { EditorApi } from '../lib/editor/RichEditor.svelte';
  import { imageInput, textareaField, type ImageField, type UploadTarget } from '../lib/imageInput.ts';
  import { editorModule, loadEditor } from '../lib/richtext.ts';

  interface Props {
    value: string;
    onchange: (markdown: string) => void;
    placeholder?: string;
    upload?: UploadTarget;
    onsubmit?: () => boolean | void;
    onescape?: () => boolean | void;
    onblur?: () => void;
    focusAt?: { x: number; y: number } | 'end' | null;
    testid?: string;
    class?: string;
    label?: string;
    /** Field for the image button (editor or textarea) */
    field?: ImageField | null;
  }

  let { value, onchange, placeholder = '', upload, onsubmit, onescape, onblur, focusAt = null, testid, class: cls = '', label, field = $bindable(null) }: Props = $props();

  let mod = $state(editorModule());
  let failed = $state(false);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  // Carry focus over when switching from the textarea to the editor
  // svelte-ignore state_referenced_locally
  let handoff = $state<typeof focusAt>(focusAt);

  function load() {
    if (mod || failed) return;
    loadEditor().then(
      (m) => {
        if (textarea && document.activeElement === textarea) handoff = 'end';
        mod = m;
      },
      () => (failed = true),
    );
  }

  /** Textarea or editor, whichever is shown right now. */
  let current: ImageField | null = null;
  const proxy: ImageField = {
    insertImages: (images) => current?.insertImages(images),
    replaceImage: (id, next) => current?.replaceImage(id, next) ?? false,
    get connected() {
      return !!current?.connected;
    },
  };

  $effect(() => {
    if (!mod && textarea) current = textareaField(textarea);
  });
  $effect(() => {
    field = proxy;
    return () => {
      current = null;
      field = null;
    };
  });
</script>

{#if mod}
  <mod.default
    {value}
    {onchange}
    {placeholder}
    {upload}
    {onsubmit}
    {onescape}
    {onblur}
    focusAt={handoff}
    {testid}
    class={cls}
    {label}
    imageField={proxy}
    onready={(api: EditorApi | null) => (current = api)}
  />
{:else}
  <textarea
    class={cls}
    data-testid={testid}
    aria-label={label ?? placeholder}
    {placeholder}
    {value}
    bind:this={textarea}
    oninput={(e) => onchange(e.currentTarget.value)}
    onfocus={load}
    onpointerdown={load}
    onblur={() => onblur?.()}
    onkeydown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onsubmit?.() === true) {
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Escape' && onescape?.() === true) {
        e.preventDefault();
        e.stopPropagation();
      }
    }}
    {@attach (el: HTMLTextAreaElement) => {
      if (focusAt) queueMicrotask(() => el.focus({ preventScroll: true }));
    }}
    {@attach upload ? imageInput(upload, proxy) : () => {}}
  ></textarea>
{/if}
