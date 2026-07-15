import { CopyIcon } from '@/components/icons';
import { OverlayCircleButton } from './OverlayCircleButton';

interface CopyWorkflowButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function CopyWorkflowButton({ onClick, disabled }: CopyWorkflowButtonProps) {
  return (
    <OverlayCircleButton
      onClick={onClick}
      ariaLabel="Copy workflow debug bundle"
      disabled={disabled}
      className="text-white"
      icon={<CopyIcon className="w-5 h-5" />}
    />
  );
}
