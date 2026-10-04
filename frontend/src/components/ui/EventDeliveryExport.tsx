import { useState } from 'react';
import { Download, FileSpreadsheet } from 'lucide-react';
import api from '../../services/api';
import { useToast } from './Toast';
import {
  exportEventDeliveryExcel,
  exportEventDeliveryPdf,
  fetchAllDeliveryRows,
} from '../../utils/eventDeliveryExport';

/**
 * Excel and PDF of one event's Delivery Log, for the View page of an event
 * that has no sent campaign - the campaign view carries its own downloads.
 *
 * It sits beside the page's heading rather than inside the log, so the log
 * itself looks exactly as it does everywhere else.
 *
 * The download reads every message of the event at the moment it is pressed,
 * not the rows on screen: the table may be filtered by status or showing only
 * the latest 200, and a downloaded log has to be the whole of it.
 */
interface EventDeliveryExportProps {
  eventId: string;
  /** "EVT-000002", for the file name. */
  eventCode: string;
  /** The event's lines for the document, as the Event Report table words them. */
  eventDetails: Array<[string, string]>;
  /**
   * Whether the event has any message at all - null until the log has loaded.
   * With none, there is nothing truthful to download, so both buttons wait.
   */
  hasMessages: boolean | null;
}

const BUTTON =
  'inline-flex items-center px-4 py-2 rounded-md font-medium text-sm transition-colors border disabled:opacity-40 disabled:cursor-not-allowed';

export const EventDeliveryExport = ({ eventId, eventCode, eventDetails, hasMessages }: EventDeliveryExportProps) => {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<'excel' | 'pdf' | null>(null);

  const run = async (kind: 'excel' | 'pdf') => {
    setBusy(kind);
    try {
      const rows = await fetchAllDeliveryRows(async (page, limit) => {
        const res = await api.get(`/reports/event/${eventId}/delivery-log`, { params: { page, limit } });
        return { logs: res.data?.logs ?? [], total: res.data?.pagination?.total ?? 0 };
      });
      // Checked again at the moment of download: a log that has since emptied
      // must not produce a document of nothing.
      if (rows.length === 0) {
        showToast('warning', 'This event has no messages to export.');
        return;
      }
      const file =
        kind === 'excel'
          ? await exportEventDeliveryExcel(eventCode, eventDetails, rows)
          : await exportEventDeliveryPdf(eventCode, eventDetails, rows);
      showToast('success', `${file} downloaded`);
    } catch (error) {
      console.error('Delivery Log export failed', error);
      showToast('error', 'Could not generate the file. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const unavailable = hasMessages !== true;
  const title = hasMessages === false ? 'This event has no messages to export' : undefined;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void run('excel')}
        disabled={unavailable || busy !== null}
        title={title}
        className={`${BUTTON} bg-accent/10 text-accent hover:bg-accent/20 border-accent/20`}
      >
        <FileSpreadsheet className="w-4 h-4 mr-2" />
        {busy === 'excel' ? 'Preparing...' : 'Excel'}
      </button>
      <button
        type="button"
        onClick={() => void run('pdf')}
        disabled={unavailable || busy !== null}
        title={title}
        className={`${BUTTON} bg-primary/10 text-primary hover:bg-primary/20 border-primary/20`}
      >
        <Download className="w-4 h-4 mr-2" />
        {busy === 'pdf' ? 'Preparing...' : 'PDF'}
      </button>
    </div>
  );
};
