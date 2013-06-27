/**
 * Copyright 2013 Facebook, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @providesModule ReactComponent
 */

/*jslint evil: true */

"use strict";

var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactDOMIDOperations = require("./ReactDOMIDOperations");
var ReactID = require("./ReactID");
var ReactMount = require("./ReactMount");
var ReactOwner = require("./ReactOwner");
var ReactReconcileTransaction = require("./ReactReconcileTransaction");

var invariant = require("./invariant");
var keyMirror = require("./keyMirror");
var merge = require("./merge");

/**
 * Prop key that references a component's owner.
 * @private
 */
var OWNER = '{owner}';

/**
 * Every React component is in one of these life cycles.
 */
var ComponentLifeCycle = keyMirror({
  /**
   * Mounted components have a DOM node representation and are capable of
   * receiving new props.
   */
  MOUNTED: null,
  /**
   * Unmounted components are inactive and cannot receive new props.
   */
  UNMOUNTED: null
});

/**
 * Warn if there's no key explicitly set on dynamic arrays of children.
 * This allows us to keep track of children between updates.
 */

var CHILD_HAS_NO_IDENTITY =
  'Each child in an array should have a unique "key" prop. ' +
  'Check the render method of ';

var CHILD_CAME_FROM_ANOTHER_OWNER = '. It was passed a child from ';

var ownerHasWarned = {};

/**
 * Helpers for flattening child arguments onto a new array or use an existing
 * one.
 */

/**
 * Generate a unique key that identifies this child within a set.
 *
 * @param {*} Manually provided key.
 * @param {number} Index that is used if a manual key is not provided.
 * @param {?number} Grouping index if this is used in a nested array.
 * @return {string}
 */
function createKey(explicitKey, childIndex, groupingIndex) {
  return ReactCurrentOwner.getDepth() + ':' +
         (groupingIndex == null ? '' : groupingIndex + ':') +
         (explicitKey == null ? '' + childIndex : explicitKey);
}

/**
 * Returns true if this parameter type is considered an empty child slot.
 * Used to filter out empty slots and generate a compact array.
 *
 * @param {*} Child component or any value.
 * @return {boolean}
 */
function isEmptyChild(child) {
  return child == null || typeof child === 'boolean';
}

/**
 * Assign an internal identity to a child component.
 *
 * @param {number} Index of the current array grouping.
 * @param {*} Child component or any value.
 * @param {number} Index of the current child within it's grouping.
 */
function assignKey(groupingIndex, child, index) {
  // Only truthy internal keys are valid. If it's not, we assign one.
  if (ReactComponent.isValidComponent(child) && !child._key) {
      var key = child.props.key;
      child._key = createKey(key, index, groupingIndex);
  }
}

/**
 * Make sure all children have an internal identity. Returns true if this is
 * already a compact array.
 *
 * @param {array} Children of any type.
 * @return {boolean}
 */
function tryToReuseArray(children) {
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (isEmptyChild(child)) {
      return false;
    }
    assignKey(0, child, i);
  }
  return true;
}

/**
 * Append children from the source array to the target array. Make sure all
 * children have an internal identity assigned to it based on insertion point.
 *
 * @param {number} Index of the current array grouping.
 * @param {array} Source array.
 * @param {array} Target array that will be appended to.
 */
function appendNestedChildren(groupingIndex, sourceArray, targetArray) {
  for (var i = 0; i < sourceArray.length; i++) {
    var child = sourceArray[i];
    if (isEmptyChild(child)) {
      continue;
    }
    assignKey(groupingIndex, child, i);
    // TODO: Invalid components like strings could possibly need
    // keys assigned to them here. Usually they're not stateful but
    // CSS transitions and special events could make them stateful.
    targetArray.push(child);
  }
}

/**
 * Components are the basic units of composition in React.
 *
 * Every component accepts a set of keyed input parameters known as "props" that
 * are initialized by the constructor. Once a component is mounted, the props
 * can be mutated using `setProps` or `replaceProps`.
 *
 * Every component is capable of the following operations:
 *
 *   `mountComponent`
 *     Initializes the component, renders markup, and registers event listeners.
 *
 *   `receiveProps`
 *     Updates the rendered DOM nodes given a new set of props.
 *
 *   `unmountComponent`
 *     Releases any resources allocated by this component.
 *
 * Components can also be "owned" by other components. Being owned by another
 * component means being constructed by that component. This is different from
 * being the child of a component, which means having a DOM representation that
 * is a child of the DOM representation of that component.
 *
 * @class ReactComponent
 */
var ReactComponent = {

  /**
   * @param {?object} object
   * @return {boolean} True if `object` is a valid component.
   * @final
   */
  isValidComponent: function(object) {
    return !!(
      object &&
      typeof object.mountComponentIntoNode === 'function' &&
      typeof object.receiveProps === 'function'
    );
  },

  /**
   * @internal
   */
  LifeCycle: ComponentLifeCycle,

  /**
   * React references `ReactDOMIDOperations` using this property in order to
   * allow dependency injection.
   *
   * @internal
   */
  DOMIDOperations: ReactDOMIDOperations,

  /**
   * React references `ReactReconcileTransaction` using this property in order
   * to allow dependency injection.
   *
   * @internal
   */
  ReactReconcileTransaction: ReactReconcileTransaction,

  /**
   * @param {object} DOMIDOperations
   * @final
   */
  setDOMOperations: function(DOMIDOperations) {
    ReactComponent.DOMIDOperations = DOMIDOperations;
  },

  /**
   * @param {Transaction} ReactReconcileTransaction
   * @final
   */
  setReactReconcileTransaction: function(ReactReconcileTransaction) {
    ReactComponent.ReactReconcileTransaction = ReactReconcileTransaction;
  },

  /**
   * Base functionality for every ReactComponent constructor.
   *
   * @lends {ReactComponent.prototype}
   */
  Mixin: {

    /**
     * Checks whether or not this component is mounted.
     *
     * @return {boolean} True if mounted, false otherwise.
     * @final
     * @protected
     */
    isMounted: function() {
      return this._lifeCycleState === ComponentLifeCycle.MOUNTED;
    },

    /**
     * Returns the DOM node rendered by this component.
     *
     * @return {?DOMElement} The root node of this component.
     * @final
     * @protected
     */
    getDOMNode: function() {
      invariant(this.isMounted());
      return ReactID.getNode(this._rootNodeID);
    },

    /**
     * Sets a subset of the props.
     *
     * @param {object} partialProps Subset of the next props.
     * @final
     * @public
     */
    setProps: function(partialProps) {
      this.replaceProps(merge(this.props, partialProps));
    },

    /**
     * Replaces all of the props.
     *
     * @param {object} props New props.
     * @final
     * @public
     */
    replaceProps: function(props) {
      invariant(!this.props[OWNER]);
      var transaction = ReactComponent.ReactReconcileTransaction.getPooled();
      transaction.perform(this.receiveProps, this, props, transaction);
      ReactComponent.ReactReconcileTransaction.release(transaction);
    },

    /**
     * Base constructor for all React component.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.construct.call(this, ...)`.
     *
     * @param {?object} initialProps
     * @param {*} children
     * @internal
     */
    construct: function(initialProps, children) {
      this.props = initialProps || {};
      // Record the component responsible for creating this component.
      this.props[OWNER] = ReactCurrentOwner.current;
      // All components start unmounted.
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;

      // Children can be either an array or more than one argument
      if (arguments.length < 2) {
        return;
      }

      if (arguments.length === 2) {

        // A single string or number child is treated as content, not an array.
        var type = typeof children;
        if (children == null || type === 'string' || type === 'number') {
          this.props.children = children;
          return;
        }

        // A single array can be reused if it's already flat
        if (Array.isArray(children) && tryToReuseArray(children)) {
          this.props.children = children;
          return;
        }

      }

      // Subsequent arguments are rolled into one child array. Array arguments
      // are flattened onto it. This is inlined to avoid extra heap allocation.
      var targetArray = null;
      for (var i = 1; i < arguments.length; i++) {
        var child = arguments[i];
        if (Array.isArray(child)) {
          if (child.length === 0) {
            continue;
          }

          if (targetArray === null) {
            targetArray = [];
          }
          appendNestedChildren(i - 1, child, targetArray);

        } else if (!isEmptyChild(child)) {

          // Only truthy internal keys are valid. If it's not, we assign one.
          if (ReactComponent.isValidComponent(child) && !child._key) {
            // This is a static node and therefore safe to key by index.
            // No warning necessary.
            child._key = createKey(child.props.key, i - 1);
          }

          if (targetArray === null) {
            targetArray = [];
          }
          targetArray.push(child);

        }
      }
      this.props.children = targetArray;
    },

    /**
     * Initializes the component, renders markup, and registers event listeners.
     *
     * NOTE: This does not insert any nodes into the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.mountComponent.call(this, ...)`.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {ReactReconcileTransaction} transaction
     * @return {?string} Rendered markup to be inserted into the DOM.
     * @internal
     */
    mountComponent: function(rootID, transaction) {
      invariant(!this.isMounted());
      var props = this.props;
      if (props.ref != null) {
        ReactOwner.addComponentAsRefTo(this, props.ref, props[OWNER]);
      }
      this._rootNodeID = rootID;
      this._lifeCycleState = ComponentLifeCycle.MOUNTED;
      // Effectively: return '';
    },

    /**
     * Releases any resources allocated by `mountComponent`.
     *
     * NOTE: This does not remove any nodes from the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.unmountComponent.call(this)`.
     *
     * @internal
     */
    unmountComponent: function() {
      invariant(this.isMounted());
      var props = this.props;
      if (props.ref != null) {
        ReactOwner.removeComponentAsRefFrom(this, props.ref, props[OWNER]);
      }
      ReactID.purgeID(this._rootNodeID);
      this._rootNodeID = null;
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;
    },

    /**
     * Updates the rendered DOM nodes given a new set of props.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.receiveProps.call(this, ...)`.
     *
     * @param {object} nextProps Next set of properties.
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    receiveProps: function(nextProps, transaction) {
      invariant(this.isMounted());
      var props = this.props;
      // If either the owner or a `ref` has changed, make sure the newest owner
      // has stored a reference to `this`, and the previous owner (if different)
      // has forgotten the reference to `this`.
      if (nextProps[OWNER] !== props[OWNER] || nextProps.ref !== props.ref) {
        if (props.ref != null) {
          ReactOwner.removeComponentAsRefFrom(this, props.ref, props[OWNER]);
        }
        // Correct, even if the owner is the same, and only the ref has changed.
        if (nextProps.ref != null) {
          ReactOwner.addComponentAsRefTo(this, nextProps.ref, nextProps[OWNER]);
        }
      }
    },

    /**
     * Mounts this component and inserts it into the DOM.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @internal
     * @see {ReactMount.renderComponent}
     */
    mountComponentIntoNode: function(rootID, container, shouldReuseMarkup) {
      var transaction = ReactComponent.ReactReconcileTransaction.getPooled();
      transaction.perform(
        this._mountComponentIntoNode,
        this,
        rootID,
        container,
        transaction,
        shouldReuseMarkup
      );
      ReactComponent.ReactReconcileTransaction.release(transaction);
    },

    /**
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {ReactReconcileTransaction} transaction
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @private
     */
    _mountComponentIntoNode: function(
        rootID,
        container,
        transaction,
        shouldReuseMarkup) {
      invariant(container && container.nodeType === 1);
      var renderStart = Date.now();
      var markup = this.mountComponent(rootID, transaction);
      ReactMount.totalInstantiationTime += (Date.now() - renderStart);

      if (shouldReuseMarkup) {
        return;
      }

      var injectionStart = Date.now();
      // Asynchronously inject markup by ensuring that the container is not in
      // the document when settings its `innerHTML`.
      var parent = container.parentNode;
      if (parent) {
        var next = container.nextSibling;
        parent.removeChild(container);
        container.innerHTML = markup;
        if (next) {
          parent.insertBefore(container, next);
        } else {
          parent.appendChild(container);
        }
      } else {
        container.innerHTML = markup;
      }
      ReactMount.totalInjectionTime += (Date.now() - injectionStart);
    },

    /**
     * Unmounts this component and removes it from the DOM.
     *
     * @param {DOMElement} container DOM element to unmount from.
     * @final
     * @internal
     * @see {ReactMount.unmountAndReleaseReactRootNode}
     */
    unmountComponentFromNode: function(container) {
      this.unmountComponent();
      // http://jsperf.com/emptying-a-node
      while (container.lastChild) {
        container.removeChild(container.lastChild);
      }
    },

    /**
     * Checks if this component is owned by the supplied `owner` component.
     *
     * @param {ReactComponent} owner Component to check.
     * @return {boolean} True if `owners` owns this component.
     * @final
     * @internal
     */
    isOwnedBy: function(owner) {
      return this.props[OWNER] === owner;
    },

    /**
     * Gets another component, that shares the same owner as this one, by ref.
     *
     * @param {string} ref of a sibling Component.
     * @return {?ReactComponent} the actual sibling Component.
     * @final
     * @internal
     */
    getSiblingByRef: function(ref) {
      var owner = this.props[OWNER];
      if (!owner || !owner.refs) {
        return null;
      }
      return owner.refs[ref];
    }

  }

};

module.exports = ReactComponent;
