import React, { Component } from 'react';

export const parseBody = (response, mapping = {}) => {
  const contentType = response.headers.get('Content-Type');

  // Do not attempt to parse empty response
  if (contentType === null) {
    return Promise.resolve(null)
  }

  const mimeType = contentType.split(';')[0].trim();

  if (mimeType in mapping) {
    // Direct mapping of `Content-Type`/`mimeType` to response handler
    return mapping[mimeType](response)
  } else if (
    mimeType === 'application/json' ||
    mimeType === 'text/json' ||
    /\+json$/.test(mimeType) // ends with "+json"
  ) {
    // https://mimesniff.spec.whatwg.org/#json-mime-type
    return ('json' in mapping) ? mapping['json'](response) : response.json()
  } else if (mimeType === 'text/html') {
    // https://mimesniff.spec.whatwg.org/#html-mime-type
    return ('html' in mapping) ? mapping['html'](response) : response.text()
  } else if (
    mimeType === 'application/xml' ||
    mimeType === 'text/xml' ||
    /\+xml$/.test(mimeType) // ends with "+xml"
  ) {
    // https://mimesniff.spec.whatwg.org/#xml-mime-type
    return ('xml' in mapping) ? mapping['xml'](response) : response.text()
  } else {
    return ('other' in mapping) ? mapping['other'](response) : response.arrayBuffer()
  }
};

export default class Fetch extends Component {
  static defaultProps = {
    as: 'auto',
    fetchFunction: (url, options) => fetch(url, options)
  };

  state = {
    request: {
      url: this.props.url,
      options: this.props.options
    },
    fetch: this.fetch.bind(this),
    clearData: this.clearData.bind(this),
    loading: null
  };
  cache = null;
  promises = [];

  getOptions(options) {
    return typeof options === 'function' ? options() : options;
  }

  setCache(cache) {
    this.cache = this.props.cache === true ? new SimpleCache() 
      : typeof this.props.cache === "object" ? this.props.cache 
      : null;
  }

  componentDidMount() {
    const { url, options, manual, onChange, cache } = this.props;
    this.mounted = true;

    this.setCache(cache);

    if (typeof onChange === 'function') {
      onChange(this.state);
    }

    if (url && !manual) {
      this.fetch(url, options);
    }
  }

  componentDidUpdate(prevProps) {
    const { url, options, manual, cache } = this.props;
    if (url !== prevProps.url && !manual) {
      this.fetch(url, options);
    }

    if (cache !== prevProps.cache) {
      this.setCache(cache);
    }
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  fetch(url, options, updateOptions) {
    let { as, cache } = this.props;

    if (url == null) {
      url = this.props.url;
    }

    options = this.getOptions(options || this.props.options);
    const request = { url, options };

    if (this.cache && this.cache.get(url)) {
      // Restore cached state
      const promise = this.cache.get(url);
      promise.then(cachedState =>
        this.update(cachedState, promise, updateOptions)
      );
      this.promises.push(promise);
    } else {
      this.update({ request, loading: true }, null, updateOptions);

      const promise = this.props
        .fetchFunction(url, options)
        .then(response => {
          const dataPromise = 
            typeof as === 'function' ? as(response) :
            typeof as === 'object' ? parseBody(response, as) :
            as === 'auto' ? parseBody(response) :
            response[as]();

          return dataPromise
            .then(data => ({ response, data }))
            .catch(error => ({ response, data: error }));
        })
        .then(({ response, data }) => {
          const newState = {
            request,
            loading: false,
            [response.ok ? 'error' : 'data']: undefined, // Clear last response
            [response.ok ? 'data' : 'error']: data,
            response
          };

          this.update(newState, promise, updateOptions);

          return newState;
        })
        .catch(error => {
          // Catch request errors with no response (CORS issues, etc)
          const newState = {
            request,
            data: undefined,
            error,
            loading: false
          };

          this.update(newState, promise, updateOptions);

          // Rethrow so not to swallow errors, especially from errors within handlers (children func / onChange)
          throw error;

          return newState;
        });

      this.promises.push(promise);

      if (this.cache) {
        this.cache.set(url, promise);
      }

      return promise;
    }
  }

  clearData() {
    this.setState({ data: undefined });
  }

  update(nextState, currentPromise, options = {}) {
    if (currentPromise) {
      // Handle (i.e. ignore) promises resolved out of order from requests
      const index = this.promises.indexOf(currentPromise);
      if (index === -1) {
        // Ignore update as a later request/promise has already been processed
        return;
      }

      // Remove currently resolved promise and any outstanding promises
      // (which will cause them to be ignored when they do resolve/reject)
      this.promises.splice(0, index + 1);
    }

    const { onChange, onDataChange } = this.props;

    let data = undefined;
    if (
      nextState.data &&
      nextState.data !== this.state.data &&
      typeof onDataChange === 'function'
    ) {
      data = onDataChange(
        nextState.data,
        options.ignorePreviousData ? undefined : this.state.data
      );
    }

    if (typeof onChange === 'function') {
      // Always call onChange even if unmounted.  Useful for `POST` requests with a redirect
      onChange({
        ...this.state,
        ...nextState,
        ...(data !== undefined && { data })
      });
    }

    // Ignore passing state down if no longer mounted
    if (this.mounted) {
      // If `onDataChange` prop returned a value, we use it for data passed down to the children function
      this.setState({ ...nextState, ...(data !== undefined && { data }) });
    }
  }

  render() {
    const { children } = this.props;
    return renderChildren(children, this.state);
  }
}

export function renderChildren(children, fetchProps) {
  if (typeof children === 'function') {
    const childrenResult = children(fetchProps);
    if (typeof childrenResult === 'function') {
      return renderChildren(childrenResult, fetchProps);
    } else {
      return childrenResult;
    }
  } else if (React.Children.count(children) === 0) {
    return null;
  } else {
    // DOM/Component children
    // TODO: Better to check if children count === 1 and return null otherwise (like react-router)?
    //       Currently not possible to support multiple children components/elements (until React fiber)
    return React.Children.only(children);
  }
}

export class SimpleCache {
  cache = {};
  get(url) {
    return this.cache[url];
  }

  set(url, promise) {
    // TODO: only retain successful responses?
    //  `promise.then(({ error }) => { if (error) { this.remove(url) } })` (untested)
    this.cache[url] = promise;
  }

  remove(url) {
    delete this.cache[url];
  }

  clear() {
    // TODO: Wait for all outstanding promises to resolve?
    //   `Promise.all(Object.values(cache)).then(() => this.cache = {})` (untested)
    this.cache = {};
  }
}
