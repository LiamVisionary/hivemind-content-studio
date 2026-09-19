import { StudioRedirect } from '../StudioRedirect.jsx';

// /models predates the native model manager; keep the path working by sending it
// to the view that replaced it.
export default function Models() {
  return <StudioRedirect page="models" />;
}
