import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="boot-pane">
      <div>
        <h1>Page not found</h1>
        <p className="muted">That route doesn't exist in the portal.</p>
        <Link to="/dashboard" className="btn primary">Go to dashboard</Link>
      </div>
    </div>
  );
}
