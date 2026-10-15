<script lang="ts">
  // Profile: display name and picture of the owner. They show wherever the owner appears (activity,
  // comments, inbox, MCP output). Stored in Convex (meta.get → owner), not taken from Clerk, so MCP
  // and every device see the same.
  import { ICON } from '@selfbound/core';
  import { intlLocale, t } from '@selfbound/core/i18n';
  import { LIMITS } from '@selfbound/backend/constants';
  import { fromSlice } from '../../slice.svelte.ts';
  import { app } from '../../app-instance.ts';
  import Avatar from '../../components/Avatar.svelte';
  import AvatarCrop from './AvatarCrop.svelte';
  import { admin } from './admin.ts';

  /** Largest picture the browser reads for cropping (the result is 256 px and a few KB). */
  const PICK_MAX_BYTES = 10 * 1024 * 1024;
  const PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

  const metaSlice = fromSlice(app.store.meta);
  const owner = $derived(metaSlice.current?.owner);

  let name = $state('');
  let editing = $state(false);
  $effect(() => {
    const stored = owner?.name ?? '';
    if (!editing) name = stored;
  });
  function commitName() {
    editing = false;
    const next = name.replace(/\s+/g, ' ').trim();
    name = next;
    if (next !== (owner?.name ?? '')) void admin.setProfileName(next || null);
  }

  let picking = $state<ImageBitmap | null>(null);
  let pickError = $state<string | null>(null);
  async function pick(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    pickError = null;
    if (!file) return;
    if (!PICK_TYPES.includes(file.type)) return void (pickError = t('Pictures only: PNG, JPEG or WebP.'));
    if (file.size > PICK_MAX_BYTES) return void (pickError = t('The picture is too large (at most {mb} MB).', { mb: (PICK_MAX_BYTES / 1024 / 1024).toLocaleString(intlLocale()) }));
    try {
      picking = await createImageBitmap(file);
    } catch {
      pickError = t('The image cannot be read (damaged or not an image).');
    }
  }
  function closeCrop() {
    picking?.close();
    picking = null;
  }
</script>

<h1 class="page-title">{t('Profile')}</h1>
<p class="page-lead">{t('Your name and picture appear in the activity of issues, in comments, in the inbox and in what agents read through MCP. Agents keep their own names.')}</p>

<div class="card-list">
  <div class="card-row" data-testid="profile-picture-row">
    <span class="who">
      <Avatar name={owner?.name} url={owner?.avatarUrl} size={56} />
      <span class="t">{t('Picture')}<div class="sub">{t('PNG, JPEG or WebP. You choose the part that shows inside the circle.')}</div></span>
    </span>
    <span class="row-actions">
      <label class="btn small">
        <span class="icon">{@html ICON.import}</span>{owner?.avatarUrl ? t('Replace') : t('Upload')}
        <input type="file" accept="image/png,image/jpeg,image/webp" class="visually-hidden" data-testid="profile-file" onchange={(e) => void pick(e.currentTarget)} />
      </label>
      {#if owner?.avatarUrl}<button class="btn ghost small" data-testid="profile-remove-picture" onclick={() => void admin.removeAvatar()}>{t('Remove')}</button>{/if}
    </span>
  </div>
  {#if pickError}<div class="field-error pick-error" role="alert" data-testid="profile-error">{pickError}</div>{/if}
  <div class="card-row">
    <span class="t">{t('Name')}<div class="sub">{t('Shown instead of “You”. Without a name, initials and “You” are used.')}</div></span>
    <input
      class="input name"
      aria-label={t('Name')}
      data-testid="profile-name"
      placeholder={t('You')}
      maxlength={LIMITS.profileNameMax}
      bind:value={name}
      onfocus={() => (editing = true)}
      onblur={commitName}
      onkeydown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          editing = false;
          name = owner?.name ?? '';
          e.currentTarget.blur();
        }
      }}
    />
  </div>
</div>

{#if picking}
  <AvatarCrop bitmap={picking} close={closeCrop} save={(picture) => admin.uploadAvatar(picture)} />
{/if}

<style>
  .who {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .row-actions {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .name {
    width: 220px;
    max-width: 100%;
  }
  .pick-error {
    padding: 0 16px 10px;
  }
</style>
