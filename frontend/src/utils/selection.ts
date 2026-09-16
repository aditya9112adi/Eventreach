/**
 * Row-selection maths for a paginated table.
 *
 * Kept out of the component so the header checkbox's three states — none,
 * some, all — and the page-scoped "select all" can be tested directly rather
 * than through a rendered table.
 *
 * Every function returns a new Set instead of mutating the one passed in, so
 * the result can be handed straight to a React state setter.
 */

export interface PageSelectionState {
  /** Ids on the current page that are selected. */
  selectedOnPage: string[];
  /** Every row on the page is selected — the header checkbox is checked. */
  allSelected: boolean;
  /** Some but not all — the header checkbox is indeterminate. */
  someSelected: boolean;
}

export const getPageSelectionState = (
  selected: ReadonlySet<string>,
  pageIds: readonly string[]
): PageSelectionState => {
  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  // An empty page is not "all selected": the header checkbox would otherwise
  // read as checked on a page with nothing to check.
  const allSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  return {
    selectedOnPage,
    allSelected,
    someSelected: selectedOnPage.length > 0 && !allSelected,
  };
};

/**
 * Header checkbox. Selects every row on the current page, or clears them if
 * they are already all selected. Only ids on this page are touched — a
 * selection made elsewhere is left alone by this function, which matters
 * because deletion acts on whatever the set holds.
 */
export const toggleSelectAllOnPage = (
  selected: ReadonlySet<string>,
  pageIds: readonly string[]
): Set<string> => {
  const { allSelected } = getPageSelectionState(selected, pageIds);
  const next = new Set(selected);
  for (const id of pageIds) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
};

/** Row checkbox. */
export const toggleSelection = (selected: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** Drops ids that no longer exist, e.g. after a deletion refetch. */
export const pruneSelection = (
  selected: ReadonlySet<string>,
  existingIds: readonly string[]
): Set<string> => {
  const alive = new Set(existingIds);
  return new Set([...selected].filter((id) => alive.has(id)));
};
