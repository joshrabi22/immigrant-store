import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getCounts } from "./api";

const CountsContext = createContext();

export function CountsProvider({ children }) {
  const [counts, setCounts] = useState({});

  const refresh = useCallback(() => {
    getCounts().then(setCounts).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <CountsContext.Provider value={{ counts, refresh }}>
      {children}
    </CountsContext.Provider>
  );
}

export function useCounts() {
  return useContext(CountsContext);
}
