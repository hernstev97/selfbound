// Drag and drop of issues between rows, cards and columns: the payload type and how to read it.
export const ISSUES_MIME = 'application/x-selfbound-issues';
// legacy-xlr8: type of a drag started by a tab that still runs the old build.
const LEGACY_ISSUES_MIME = 'application/x-xlr8-issues';

/** Is an issue drag in progress (drag over)? */
export function hasIssueDrag(data: DataTransfer | null | undefined): boolean {
  return !!data && (data.types.includes(ISSUES_MIME) || data.types.includes(LEGACY_ISSUES_MIME));
}

/** The dragged issue ids as the raw JSON string, or '' when it is not an issue drag. */
export function issueDragPayload(data: DataTransfer | null | undefined): string {
  return data?.getData(ISSUES_MIME) || data?.getData(LEGACY_ISSUES_MIME) || '';
}
