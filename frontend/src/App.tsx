import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import ViewTabs from "./components/ViewTabs";
import Toolbar from "./components/Toolbar";
import TableView from "./components/TableView/index";
import FilterPanel from "./components/FilterPanel/index";
import { AddFieldPopover } from "./components/FieldConfig/AddFieldPopover";
import "./App.css";
import { Field, TableRecord, View, ViewFilter } from "./types";
import { fetchFields, fetchRecords, fetchViews, updateViewFilter, deleteField } from "./api";
import { filterRecords } from "./services/filterEngine";

const TABLE_ID = "tbl_requirements";

export default function App() {
  const [fields, setFields] = useState<Field[]>([]);
  const [allRecords, setAllRecords] = useState<TableRecord[]>([]);
  const [views, setViews] = useState<View[]>([]);
  const [activeViewId, setActiveViewId] = useState("view_all");
  const [filter, setFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [savedFilter, setSavedFilter] = useState<ViewFilter>({ logic: "and", conditions: [] });
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  // Close filter panel on outside click
  useEffect(() => {
    if (!filterPanelOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        filterPanelRef.current &&
        !filterPanelRef.current.contains(target) &&
        filterBtnRef.current &&
        !filterBtnRef.current.contains(target)
      ) {
        setFilterPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filterPanelOpen]);

  // Load initial data: fields, all records, views
  useEffect(() => {
    Promise.all([
      fetchFields(TABLE_ID),
      fetchRecords(TABLE_ID),
      fetchViews(TABLE_ID),
    ]).then(([f, r, v]) => {
      setFields(f);
      setAllRecords(r);
      setViews(v);
      // Store the initial saved filter from the active view
      const activeView = v.find(view => view.id === "view_all");
      if (activeView) {
        const viewFilter = activeView.filter ?? { logic: "and", conditions: [] };
        setSavedFilter(viewFilter);
        setFilter(viewFilter);
      }
    });
  }, []);

  // Pure client-side filtering — each user's filter is local, no server calls
  const displayRecords = useMemo(() => {
    if (filter.conditions.length === 0) return allRecords;
    return filterRecords(allRecords, filter, fields);
  }, [allRecords, filter, fields]);

  const handleFilterChange = useCallback((newFilter: ViewFilter) => {
    setFilter(newFilter);
  }, []);

  const handleClearFilter = useCallback(() => {
    setFilter(savedFilter);
  }, [savedFilter]);

  const handleSaveView = useCallback(async () => {
    try {
      await updateViewFilter(activeViewId, filter);
      setSavedFilter(filter);
    } catch (err) {
      console.error("Failed to save view:", err);
    }
  }, [activeViewId, filter]);

  const handleCellChange = useCallback((recordId: string, fieldId: string, value: string | number | boolean | string[] | null) => {
    setAllRecords((prev) =>
      prev.map((r) =>
        r.id === recordId ? { ...r, cells: { ...r.cells, [fieldId]: value } } : r
      )
    );
  }, []);

  const handleDeleteField = useCallback(async (fieldId: string) => {
    try {
      await deleteField(TABLE_ID, fieldId);
      setFields((prev) => prev.filter((f) => f.id !== fieldId));
      // Also remove from filter conditions if present
      setFilter((prev) => ({
        ...prev,
        conditions: prev.conditions.filter((c) => c.fieldId !== fieldId),
      }));
      setSavedFilter((prev) => ({
        ...prev,
        conditions: prev.conditions.filter((c) => c.fieldId !== fieldId),
      }));
    } catch (err) {
      console.error("Failed to delete field:", err);
      alert((err as Error).message);
    }
  }, []);

  // Track field display order from TableView (for FilterPanel dropdown consistency)
  const [orderedFields, setOrderedFields] = useState<Field[]>([]);

  const handleFieldOrderChange = useCallback((ordered: Field[]) => {
    setOrderedFields(ordered);
  }, []);

  // Add-field popover state
  const [addFieldAnchor, setAddFieldAnchor] = useState<DOMRect | null>(null);

  const handleOpenAddField = useCallback((rect: DOMRect) => {
    setAddFieldAnchor(rect);
  }, []);

  const handleCreateFieldConfirm = useCallback(async (newField: Field) => {
    setFields((prev) => [...prev, newField]);
    // Refetch records so Lookup fields get their materialized values from the backend
    const r = await fetchRecords(TABLE_ID);
    setAllRecords(r);
    setAddFieldAnchor(null);
  }, []);

  const isFiltered = filter.conditions.length > 0;

  // Dirty = local filter differs from the saved (backend) filter
  const isFilterDirty = useMemo(() => {
    return JSON.stringify(filter) !== JSON.stringify(savedFilter);
  }, [filter, savedFilter]);

  return (
    <div className="app">
      <TopBar tableName="需求管理表" />
      <div className="app-body">
        <Sidebar />
        <div className="app-main">
          <ViewTabs
            views={views}
            activeViewId={activeViewId}
            onSelect={setActiveViewId}
            isFiltered={isFiltered}
            isFilterDirty={isFilterDirty}
            onSaveView={handleSaveView}
            onClearFilter={handleClearFilter}
          />
          <Toolbar
            isFiltered={isFiltered}
            filterConditionCount={filter.conditions.length}
            filterPanelOpen={filterPanelOpen}
            onFilterClick={() => setFilterPanelOpen((o) => !o)}
            onClearFilter={handleClearFilter}
            filterBtnRef={filterBtnRef}
          />
          <div className="app-content">
            <TableView
              fields={fields}
              records={displayRecords}
              onCellChange={handleCellChange}
              onDeleteField={handleDeleteField}
              onFieldOrderChange={handleFieldOrderChange}
              onAddField={handleOpenAddField}
            />
            {filterPanelOpen && (
              <FilterPanel
                ref={filterPanelRef}
                tableId={TABLE_ID}
                fields={orderedFields.length > 0 ? orderedFields : fields}
                filter={filter}
                onFilterChange={handleFilterChange}
                onClose={() => setFilterPanelOpen(false)}
                anchorRef={filterBtnRef}
              />
            )}
            {addFieldAnchor && (
              <AddFieldPopover
                currentTableId={TABLE_ID}
                currentFields={fields}
                anchorRect={addFieldAnchor}
                onCancel={() => setAddFieldAnchor(null)}
                onConfirm={handleCreateFieldConfirm}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
