import type { FileItem } from "@/api/client";

export function resolveUploadFolder(
  supportsVideoUpload: boolean,
  imageFolder: string,
): string {
  return supportsVideoUpload ? "input" : imageFolder;
}

export function isOutputFileSelectable(
  fileType: FileItem["type"],
  supportsVideoUpload: boolean,
): boolean {
  if (fileType === "folder") return false;
  return supportsVideoUpload ? fileType === "video" : fileType === "image";
}

export function sortOutputPickerFiles(
  files: FileItem[],
  supportsVideoUpload: boolean,
): FileItem[] {
  return [...files].sort((a, b) => {
    const aSelectable = isOutputFileSelectable(a.type, supportsVideoUpload);
    const bSelectable = isOutputFileSelectable(b.type, supportsVideoUpload);

    if (aSelectable !== bSelectable) return aSelectable ? -1 : 1;

    const aDate = a.date ?? 0;
    const bDate = b.date ?? 0;
    if (aDate !== bDate) return bDate - aDate;

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}
