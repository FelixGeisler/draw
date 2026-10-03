import { SessionForest } from "../components/SessionForest";

export function ForestPage() {
  return (
    <div className="content forest-page">
      <h1>Forest</h1>
      <p className="forest-intro">Every working session grows this shared landscape.</p>
      <SessionForest />
    </div>
  );
}
