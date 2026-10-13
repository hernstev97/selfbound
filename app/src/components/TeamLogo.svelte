<script lang="ts">
  // Team logo always through <img> (never inline SVG from user data), otherwise a placeholder from key and color.
  import type { TeamBadge } from '@xlr8/core';

  let { team, size = 16, cls = '' }: { team: TeamBadge; size?: 14 | 16 | 20 | 24 | 32 | 40; cls?: string } = $props();
  // Logo failed to load: placeholder until a different URL arrives.
  let brokenUrl = $state<string | null>(null);
  const sizeClass = $derived(size === 14 ? 's14' : size === 20 ? 's20' : size === 24 ? 's24' : size === 32 ? 's32' : size === 40 ? 's40' : '');
</script>

{#if team.logo && brokenUrl !== team.logo}
  <span class={['team-logo img', sizeClass, cls]} title={team.name} data-logo="img">
    <img src={team.logo} alt="" loading="lazy" decoding="async" onerror={() => (brokenUrl = team.logo)} />
  </span>
{:else}
  <span class={['team-logo', sizeClass, cls]} style:--hue={team.hue} title={team.name}>{team.key.slice(0, 1)}</span>
{/if}
