import { Download, FileSpreadsheet, FileText, X } from 'lucide-react';

export interface ReportFilterOption {
  /** Stable key used in the download file name, e.g. "UserName". */
  key: string;
  /** Text shown next to the radio. */
  label: string;
  /** `date` swaps the search box for the start/end date range. */
  type: 'text' | 'date';
}

interface ReportFilterBarProps {
  options: ReportFilterOption[];
  mode: string;
  onModeChange: (key: string) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  startDate: string;
  onStartDateChange: (value: string) => void;
  endDate: string;
  onEndDateChange: (value: string) => void;
  onClear: () => void;
  onDownloadExcel: () => void;
  onDownloadPdf: () => void;
  /** Number of rows the current filter matches; download is blocked at 0. */
  resultCount: number;
  isExporting: boolean;
  /** Shown under the controls, e.g. "AccessReport_UserName_21082026". */
  fileNamePreview: string;
}

const LABEL = 'text-[10px] font-bold uppercase tracking-wider text-foreground/50 mb-1 ml-1';
const FIELD =
  'bg-surface border border-border text-foreground px-4 py-2 rounded-md focus:outline-none focus:border-accent transition-colors font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed';

export const ReportFilterBar = ({
  options,
  mode,
  onModeChange,
  searchValue,
  onSearchChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  onClear,
  onDownloadExcel,
  onDownloadPdf,
  resultCount,
  isExporting,
  fileNamePreview,
}: ReportFilterBarProps) => {
  const activeOption = options.find((option) => option.key === mode) ?? options[0];
  const isDateMode = activeOption?.type === 'date';
  const hasFilter = isDateMode ? Boolean(startDate || endDate) : Boolean(searchValue);
  const canDownload = resultCount > 0 && !isExporting;

  return (
    <div className="glass-panel rounded-2xl p-6 animate-fade-up">
      {/* Filter mode — one field at a time, which is what names the download. */}
      <fieldset>
        <legend className={LABEL}>Filter By</legend>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-1">
          {options.map((option) => (
            <label
              key={option.key}
              className="flex items-center gap-2 cursor-pointer group select-none"
            >
              <input
                type="radio"
                name="report-filter-mode"
                value={option.key}
                checked={mode === option.key}
                onChange={() => onModeChange(option.key)}
                className="w-4 h-4 accent-accent cursor-pointer"
              />
              <span className="text-sm font-bold uppercase tracking-wide text-foreground/70 group-hover:text-foreground transition-colors">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col lg:flex-row lg:items-end gap-3 mt-5">
        <div className="flex flex-col flex-1 min-w-[200px]">
          <label className={LABEL} htmlFor="report-search">
            Search Value
          </label>
          <input
            id="report-search"
            type="text"
            value={searchValue}
            disabled={isDateMode}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={isDateMode ? 'Select a date range →' : `Search by ${activeOption?.label}...`}
            className={FIELD}
          />
        </div>

        <div className="flex flex-col">
          <label className={LABEL} htmlFor="report-start">
            Start Date
          </label>
          <input
            id="report-start"
            type="date"
            value={startDate}
            max={endDate || undefined}
            disabled={!isDateMode}
            onChange={(e) => onStartDateChange(e.target.value)}
            className={FIELD}
          />
        </div>

        <div className="flex flex-col">
          <label className={LABEL} htmlFor="report-end">
            End Date
          </label>
          <input
            id="report-end"
            type="date"
            value={endDate}
            min={startDate || undefined}
            disabled={!isDateMode}
            onChange={(e) => onEndDateChange(e.target.value)}
            className={FIELD}
          />
        </div>

        {hasFilter && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center justify-center gap-1 text-foreground/50 hover:text-foreground border border-border rounded-md px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Clear
          </button>
        )}

        <div className="flex flex-col">
          <span className={LABEL}>Download</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDownloadExcel}
              disabled={!canDownload}
              title={resultCount === 0 ? 'Nothing to download' : 'Download as Excel'}
              className="flex items-center gap-2 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs px-4 py-2 rounded transition-colors uppercase tracking-wider"
            >
              <FileSpreadsheet className="w-4 h-4" /> Excel
            </button>
            <button
              type="button"
              onClick={onDownloadPdf}
              disabled={!canDownload}
              title={resultCount === 0 ? 'Nothing to download' : 'Download as PDF'}
              className="flex items-center gap-2 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-xs px-4 py-2 rounded transition-colors uppercase tracking-wider"
            >
              <FileText className="w-4 h-4" /> PDF
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-4 border-t border-border">
        <p className="text-xs text-foreground/50">
          <span className="text-accent font-bold">{resultCount}</span> record
          {resultCount === 1 ? '' : 's'} match this filter
        </p>
        <p className="text-xs text-foreground/40 flex items-center gap-1.5">
          <Download className="w-3 h-3" />
          {isExporting ? 'Preparing download...' : `${fileNamePreview}.xlsx / .pdf`}
        </p>
      </div>
    </div>
  );
};
