import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Splash from "@/pages/Splash";
import Welcome from "@/pages/Welcome";
import Register from "@/pages/Register";
import Authenticate from "@/pages/Authenticate";
import Login from "@/pages/Login";
import Verified from "@/pages/Verified";
import BarneyPhase1 from "@/pages/BarneyPhase1";
import BarneyPhase2 from "@/pages/BarneyPhase2";
import Completion from "@/pages/Completion";
import Waiting from "@/pages/Waiting";
import Pitch from "@/pages/Pitch";
import ChooseTimes from "@/pages/ChooseTimes";
import BlindDate from "@/pages/BlindDate";
import Debrief from "@/pages/Debrief";
import BarneyChatHarness from "@/pages/BarneyChatHarness";
import MatchPipeline from "@/pages/dev/MatchPipeline";
import Audit from "@/pages/dev/Audit";
import DemoNav from "@/components/DemoNav";
import TelemetryTracker from "@/components/TelemetryTracker";

export default function App() {
  return (
    <BrowserRouter>
      {/* POC-only floating page navigator — lets us step through the flow during demos. */}
      {import.meta.env.DEV && <DemoNav />}
      {/* Inside the router: it reads the current location to emit screen views (#554). */}
      <TelemetryTracker />
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/register" element={<Register />} />
        <Route path="/authenticate" element={<Authenticate />} />
        <Route path="/login" element={<Login />} />
        <Route path="/verified" element={<Verified />} />
        <Route path="/barney/phase1" element={<BarneyPhase1 />} />
        <Route path="/barney/phase2" element={<BarneyPhase2 />} />
        <Route path="/completion" element={<Completion />} />
        <Route path="/waiting" element={<Waiting />} />
        <Route path="/pitch" element={<Pitch />} />
        <Route path="/choose-times" element={<ChooseTimes />} />
        <Route path="/blind-date" element={<BlindDate />} />
        <Route path="/debrief" element={<Debrief />} />
        {import.meta.env.DEV && <Route path="/dev/barney-chat" element={<BarneyChatHarness />} />}
        {import.meta.env.DEV && <Route path="/dev/match-pipeline" element={<MatchPipeline />} />}
        {import.meta.env.DEV && <Route path="/dev/audit" element={<Audit />} />}

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
