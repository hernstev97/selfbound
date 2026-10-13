<script lang="ts">
  // Full-size pull request: /pr/<owner>/<repo>/<number>.
  import '../styles/detail.css';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import PullRequestView from '../components/pr/PullRequestView.svelte';

  const pageSlice = fromSlice(app.nav.page);
  const page = $derived(pageSlice.current.name === 'pr' ? pageSlice.current : null);
</script>

{#if page}
  {#key `${page.repo}#${page.number}`}
    <PullRequestView repo={page.repo} number={page.number} mode="page" />
  {/key}
{/if}
