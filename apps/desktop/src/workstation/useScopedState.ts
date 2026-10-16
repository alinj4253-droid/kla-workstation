import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** Async callbacks keep writing to their original room, even after navigation. */
export function useScopedState<T>(scope: string, initial: T): [T, Dispatch<SetStateAction<T>>, (scope: string, next: SetStateAction<T>) => void] {
  const [fallback] = useState(() => initial);
  const [values, setValues] = useState<Record<string, T>>({});
  const setForScope = useCallback((key: string, next: SetStateAction<T>) => {
    setValues(previous => ({ ...previous, [key]: typeof next === 'function'
      ? (next as (value: T) => T)(previous[key] ?? fallback) : next }));
  }, [fallback]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => setForScope(scope, next), [scope, setForScope]);
  return [values[scope] ?? fallback, setValue, setForScope];
}
