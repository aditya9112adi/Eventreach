import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import type { DropzoneOptions } from 'react-dropzone';
import { UploadCloud, File, X } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  accept?: DropzoneOptions['accept'];
  maxSize?: number;
  selectedFile?: File | null;
  onClear?: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({ 
  onFileSelect, 
  accept, 
  maxSize = 104857600, // 100MB default
  selectedFile,
  onClear
}) => {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      onFileSelect(acceptedFiles[0]);
    }
  }, [onFileSelect]);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({ 
    onDrop, 
    accept, 
    maxSize,
    multiple: false 
  });

  if (selectedFile) {
    return (
      <div className="flex items-center justify-between p-4 border rounded-lg bg-surface border-border">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-surfaceHover text-accent rounded-lg">
            <File className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
            <p className="text-xs text-foreground/50">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
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
        Support for a single or bulk upload. Strictly prohibit from uploading company data or other band files.
      </p>
      <p className="text-xs text-foreground/40 mt-2">
        Allowed formats: {accept ? Object.values(accept).flat().join(', ') : 'Any'} (Max {maxSize / 1024 / 1024}MB)
      </p>
    </div>
  );
};


