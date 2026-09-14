import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import type { DropzoneOptions, FileRejection } from 'react-dropzone';
import { UploadCloud, File, X, AlertTriangle } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  accept?: DropzoneOptions['accept'];
  maxSize?: number;
  selectedFile?: File | null;
  onClear?: () => void;
  /**
   * Per-MIME size ceilings, for callers whose limits differ by type (WhatsApp
   * accepts 5 MB for an image but 100 MB for a PDF). `maxSize` remains the
   * blanket ceiling, so callers that do not pass this are unaffected.
   */
  perTypeMaxBytes?: Record<string, number>;
  /** Lines describing the real limits, shown instead of a single "Max N MB". */
  limitSummary?: string[];
  /** Optional preview for an already-selected file. */
  previewUrl?: string | null;
}

const describeSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelect,
  accept,
  maxSize = 104857600, // 100MB default
  selectedFile,
  onClear,
  perTypeMaxBytes,
  limitSummary,
  previewUrl,
}) => {
  // A rejected file used to be dropped in complete silence, so picking an
  // oversized or unsupported file simply appeared to do nothing.
  const [rejection, setRejection] = useState<string | null>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    const file = acceptedFiles[0];

    const typeLimit = perTypeMaxBytes?.[file.type];
    if (typeLimit && file.size > typeLimit) {
      setRejection(
        `${file.name} is ${describeSize(file.size)}. WhatsApp accepts at most ${describeSize(typeLimit)} for this type.`
      );
      return;
    }

    setRejection(null);
    onFileSelect(file);
  }, [onFileSelect, perTypeMaxBytes]);

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    const first = rejections[0];
    const reason = first?.errors?.[0];
    setRejection(
      reason?.code === 'file-too-large'
        ? `${first.file.name} is ${describeSize(first.file.size)}, which is larger than allowed.`
        : reason?.code === 'file-invalid-type'
        ? `${first.file.name} is not a supported file type.`
        : reason?.message || 'That file could not be accepted.'
    );
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    onDropRejected,
    accept,
    maxSize,
    multiple: false
  });

  if (selectedFile) {
    return (
      <div className="flex items-center justify-between p-4 border rounded-lg bg-surface border-border">
        <div className="flex items-center space-x-3">
          {previewUrl && selectedFile.type.startsWith('image/') ? (
            <img src={previewUrl} alt="" className="w-12 h-12 object-cover rounded-lg border border-border" />
          ) : (
            <div className="p-2 bg-surfaceHover text-accent rounded-lg">
              <File className="w-6 h-6" />
            </div>
          )}
          <div>
            <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
            <p className="text-xs text-foreground/50">
              {describeSize(selectedFile.size)}
              {selectedFile.type ? ` · ${selectedFile.type}` : ''}
            </p>
          </div>
        </div>
        {onClear && (
          <button 
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="p-2 text-foreground/40 hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <>
    {rejection && (
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span>{rejection}</span>
      </div>
    )}
    <div
      {...getRootProps()}
      className={`
        border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
        flex flex-col items-center justify-center min-h-[200px]
        ${isDragActive ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50 hover:bg-surface/50'}
        ${isDragReject ? 'border-destructive bg-destructive/10' : ''}
      `}
    >
      <input {...getInputProps()} />
      <div className="w-12 h-12 bg-surfaceHover text-foreground/50 rounded-full flex items-center justify-center mb-4">
        <UploadCloud className="w-6 h-6" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {isDragActive ? 'Drop the file here' : 'Click or drag file to this area to upload'}
      </p>
      <p className="text-xs text-foreground/50">
        A single file at a time.
      </p>
      {limitSummary && limitSummary.length > 0 ? (
        // Real per-type limits, because one blanket figure would overstate
        // what WhatsApp accepts for most types.
        <ul className="mt-2 space-y-0.5">
          {limitSummary.map((line) => (
            <li key={line} className="text-xs text-foreground/40">{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-foreground/40 mt-2">
          Allowed formats: {accept ? Object.values(accept).flat().join(', ') : 'Any'} (Max {maxSize / 1024 / 1024}MB)
        </p>
      )}
    </div>
    </>
  );
};


