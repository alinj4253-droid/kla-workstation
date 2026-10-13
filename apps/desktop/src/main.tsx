import 'core-js/actual/array/at';
import 'core-js/actual/object/has-own';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Workstation } from './workstation/Workstation';
import { LocalApprovalDialog } from './workstation/LocalApprovalDialog';
import './workstation/workstation.css';
import './workstation/agents.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Workstation />
    <LocalApprovalDialog />
  </React.StrictMode>,
);
