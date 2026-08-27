import { useState, useEffect, useCallback, useRef } from 'react';
import { generateReport } from '../reports/reportGenerator';
import { exportToCsv } from '../reports/csvExporter';
import { pushToSheets, isAuthenticated } from '../reports/sheetsExporter';
import { DEFAULT_REPORT_CONFIG } from '../reports/reportConfig';

const STORAGE_KEY = 'capacity-report-scheduler-config';
const CHECK_INTERVAL_MS = 60_000; // Check every minute

const DEFAULT_SCHEDULER_CONFIG = {
  enabled: false,
  intervalHours: 24,
  lastRun: null,
  nextRun: null,
  destination: 'csv', // 'csv' | 'sheets' | 'both'
  sheetsConfig: {
    spreadsheetId: null,
    createNewDaily: false,
  },
  reportConfig: { ...DEFAULT_REPORT_CONFIG },
};

function loadConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return { ...DEFAULT_SCHEDULER_CONFIG, ...JSON.parse(saved) };
    }
  } catch {
    // Ignore parse errors
  }
  return { ...DEFAULT_SCHEDULER_CONFIG };
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function useReportScheduler(model, loadData) {
  const [config, setConfigState] = useState(loadConfig);
  const [status, setStatus] = useState({
    running: false,
    lastResult: null,
    lastError: null,
  });
  const modelRef = useRef(model);
  modelRef.current = model;

  const setConfig = useCallback((updater) => {
    setConfigState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveConfig(next);
      return next;
    });
  }, []);

  const executeReport = useCallback(
    async (overrideConfig) => {
      const cfg = overrideConfig || config;
      const currentModel = modelRef.current;
      if (!currentModel) {
        setStatus((s) => ({
          ...s,
          lastError: 'No data loaded',
          running: false,
        }));
        return null;
      }

      setStatus((s) => ({ ...s, running: true, lastError: null }));

      try {
        // Optionally refresh data
        if (loadData) {
          try {
            await loadData();
          } catch {
            // Continue with existing data
          }
        }

        const report = generateReport(modelRef.current, cfg.reportConfig);
        let sheetsResult = null;

        if (cfg.destination === 'csv' || cfg.destination === 'both') {
          exportToCsv(report);
        }

        if (cfg.destination === 'sheets' || cfg.destination === 'both') {
          const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
          if (!clientId) {
            throw new Error('Google Client ID not configured (VITE_GOOGLE_CLIENT_ID)');
          }
          if (!isAuthenticated()) {
            throw new Error('Google Sheets auth required. Please authenticate first.');
          }
          sheetsResult = await pushToSheets(report, {
            spreadsheetId: cfg.sheetsConfig.createNewDaily
              ? null
              : cfg.sheetsConfig.spreadsheetId,
            clientId,
          });
        }

        const now = new Date().toISOString();
        setConfig((prev) => ({
          ...prev,
          lastRun: now,
          nextRun: new Date(
            Date.now() + prev.intervalHours * 3600_000
          ).toISOString(),
        }));

        setStatus({
          running: false,
          lastResult: {
            time: now,
            success: true,
            sheetsUrl: sheetsResult?.url || null,
          },
          lastError: null,
        });

        return report;
      } catch (err) {
        setStatus({
          running: false,
          lastResult: null,
          lastError: err.message,
        });
        return null;
      }
    },
    [config, loadData, setConfig]
  );

  // Scheduler interval
  useEffect(() => {
    if (!config.enabled || !modelRef.current) return;

    const check = () => {
      if (!config.nextRun) return;
      const now = Date.now();
      const next = new Date(config.nextRun).getTime();
      if (now >= next) {
        executeReport();
      }
    };

    const interval = setInterval(check, CHECK_INTERVAL_MS);
    // Check immediately on mount (catch missed runs)
    check();

    return () => clearInterval(interval);
  }, [config.enabled, config.nextRun, executeReport]);

  const enableScheduler = useCallback(() => {
    setConfig((prev) => ({
      ...prev,
      enabled: true,
      nextRun: new Date(
        Date.now() + prev.intervalHours * 3600_000
      ).toISOString(),
    }));
  }, [setConfig]);

  const disableScheduler = useCallback(() => {
    setConfig((prev) => ({ ...prev, enabled: false, nextRun: null }));
  }, [setConfig]);

  return {
    config,
    setConfig,
    status,
    executeReport,
    enableScheduler,
    disableScheduler,
    isSchedulerActive: config.enabled,
  };
}
