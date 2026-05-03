import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ModelCombobox from './ModelCombobox';

describe('ModelCombobox data-test-state precedence', () => {
  it('renders empty when no models and no error', () => {
    const { getByTestId } = render(
      <ModelCombobox models={[]} selected="" onSelect={() => undefined} />
    );
    expect(getByTestId('model-selector').getAttribute('data-test-state')).toBe('empty');
  });

  it('renders loaded when models are present and no error', () => {
    const { getByTestId } = render(
      <ModelCombobox models={[{ id: 'm-1' }]} selected="m-1" onSelect={() => undefined} />
    );
    expect(getByTestId('model-selector').getAttribute('data-test-state')).toBe('loaded');
  });

  it('renders error when an error is set even if models are present', () => {
    const { getByTestId } = render(
      <ModelCombobox
        models={[{ id: 'm-1' }]}
        selected="m-1"
        onSelect={() => undefined}
        error="Failed to set model"
      />
    );
    expect(getByTestId('model-selector').getAttribute('data-test-state')).toBe('error');
  });

  it('renders error when an error is set and models are empty', () => {
    const { getByTestId } = render(
      <ModelCombobox
        models={[]}
        selected=""
        onSelect={() => undefined}
        error="Failed to load catalog"
      />
    );
    expect(getByTestId('model-selector').getAttribute('data-test-state')).toBe('error');
  });
});
