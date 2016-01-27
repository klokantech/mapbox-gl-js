'use strict';

var featureFilter = require('feature-filter');

var ElementGroups = require('./element_groups');
var Buffer = require('./buffer');
var StyleLayer = require('../style/style_layer');
var util = require('../util/util');

module.exports = Bucket;

/**
 * Instantiate the appropriate subclass of `Bucket` for `options`.
 * @private
 * @param options See `Bucket` constructor options
 * @returns {Bucket}
 */
Bucket.create = function(options) {
    var Classes = {
        fill: require('./fill_bucket'),
        line: require('./line_bucket'),
        circle: require('./circle_bucket'),
        symbol: require('./symbol_bucket')
    };
    return new Classes[options.layer.type](options);
};

Bucket.AttributeType = Buffer.AttributeType;

/**
 * The `Bucket` class builds a set of `Buffer`s for a set of vector tile
 * features.
 *
 * `Bucket` is an abstract class. A subclass exists for each Mapbox GL
 * style spec layer type. Because `Bucket` is an abstract class,
 * instances should be created via the `Bucket.create` method.
 *
 * For performance reasons, `Bucket` creates its "add"s methods at
 * runtime using `new Function(...)`.
 *
 * @class Bucket
 * @private
 * @param options
 * @param {number} options.zoom Zoom level of the buffers being built. May be
 *     a fractional zoom level.
 * @param options.layer A Mapbox GL style layer object
 * @param {Object.<string, Buffer>} options.buffers The set of `Buffer`s being
 *     built for this tile. This object facilitates sharing of `Buffer`s be
       between `Bucket`s.
 */
function Bucket(options) {
    this.zoom = options.zoom;
    this.overscaling = options.overscaling;

    this.layer = StyleLayer.create(options.layer);
    this.layer.cascade([], {transition: false});
    this.layer.recalculate(this.zoom, { lastIntegerZoom: Infinity, lastIntegerZoomTime: 0, lastZoom: 0 });

    this.layers = [this.layer.id];
    this.type = this.layer.type;
    this.features = [];
    this.id = this.layer.id;
    this['source-layer'] = this.layer['source-layer'];
    this.interactive = this.layer.interactive;
    this.minZoom = this.layer.minzoom;
    this.maxZoom = this.layer.maxzoom;
    this.filter = featureFilter(this.layer.filter);

    if (options.elementGroups) {
        this.elementGroups = options.elementGroups;
        this.buffers = options.buffers;
    } else {
        this.resetBuffers(options.buffers);
    }

    for (var shaderName in this.shaders) {
        var shader = this.shaders[shaderName];
        this[this.getAddMethodName(shaderName, 'vertex')] = createVertexAddMethod(
            shaderName,
            shader,
            this.getBufferName(shaderName, 'vertex'),
            this.getAttributes(shaderName, {isEnabled: true})
        );
    }
}

/**
 * Build the buffers! Features are set directly to the `features` property.
 * @private
 */
Bucket.prototype.addFeatures = function() {
    for (var i = 0; i < this.features.length; i++) {
        this.addFeature(this.features[i]);
    }
};

/**
 * Check if there is enough space available in the current element group for
 * `vertexLength` vertices. If not, append a new elementGroup. Should be called
 * by `addFeatures` and its callees.
 * @private
 * @param {string} shaderName the name of the shader associated with the buffer that will receive the vertices
 * @param {number} vertexLength The number of vertices that will be inserted to the buffer.
 */
Bucket.prototype.makeRoomFor = function(shaderName, vertexLength) {
    return this.elementGroups[shaderName].makeRoomFor(vertexLength);
};

/**
 * Start using a new shared `buffers` object and recreate instances of `Buffer`
 * as necessary.
 * @private
 * @param {Object.<string, Buffer>} buffers
 */
Bucket.prototype.resetBuffers = function(buffers) {
    this.buffers = buffers;
    this.elementGroups = {};

    for (var shaderName in this.shaders) {
        var shader = this.shaders[shaderName];

        var vertexBufferName = this.getBufferName(shaderName, 'vertex');
        if (shader.vertexBuffer && !buffers[vertexBufferName]) {
            buffers[vertexBufferName] = new Buffer({
                type: Buffer.BufferType.VERTEX,
                attributes: this.getAttributes(shaderName, {isEnabled: true})
            });
        }

        if (shader.elementBuffer) {
            var elementBufferName = this.getBufferName(shaderName, 'element');
            if (!buffers[elementBufferName]) {
                buffers[elementBufferName] = createElementBuffer(shader.elementBufferComponents);
            }
            this[this.getAddMethodName(shaderName, 'element')] = createElementAddMethod(this.buffers[elementBufferName]);
        }

        if (shader.secondElementBuffer) {
            var secondElementBufferName = this.getBufferName(shaderName, 'secondElement');
            if (!buffers[secondElementBufferName]) {
                buffers[secondElementBufferName] = createElementBuffer(shader.secondElementBufferComponents);
            }
            this[this.getAddMethodName(shaderName, 'secondElement')] = createElementAddMethod(this.buffers[secondElementBufferName]);
        }

        this.elementGroups[shaderName] = new ElementGroups(
            buffers[this.getBufferName(shaderName, 'vertex')],
            buffers[this.getBufferName(shaderName, 'element')],
            buffers[this.getBufferName(shaderName, 'secondElement')]
        );
    }
};

Bucket.prototype.getAttributes = function(shaderName, filters) {
    filters = filters || {};
    filters.isDisabled = filters.isEnabled === undefined ? filters.isDisabled : !filters.isEnabled;

    var output = [];

    var attributes = this.shaders[shaderName].attributes;
    for (var i = 0; i < attributes.length; i++) {
        var attribute = attributes[i];
        var isDisabled = this.isAttributeDisabled(attribute);
        if (filters.isDisabled === undefined || filters.isDisabled === isDisabled) {
            output.push(attribute);
        }
    }

    return output;
};

Bucket.prototype.isAttributeDisabled = function(attribute) {
    if (attribute.isDisabled === undefined || attribute.isDisabled === false) {
        return false;
    } else if (attribute.isDisabled === true) {
        return true;
    } else {
        return !!attribute.isDisabled.call(this);
    }
};

/**
 * Set the attribute pointers in a WebGL context
 * @private
 * @param gl The WebGL context
 * @param shader The active WebGL shader
 * @param {number} offset The offset of the attribute data in the currently bound GL buffer.
 * @param {Array} arguments to be passed to disabled attribute value functions
 */
Bucket.prototype.setAttribPointers = function(shaderName, gl, glShader, offset, args) {
    // Set disabled attributes
    var disabledAttributes = this.getAttributes(shaderName, {isDisabled: true});
    for (var i = 0; i < disabledAttributes.length; i++) {
        var attribute = disabledAttributes[i];
        var glAttribute = glShader['a_' + attribute.name];
        gl.disableVertexAttribArray(glAttribute);
        gl['vertexAttrib' + attribute.components + 'fv'](glAttribute, this._getAttributeValue(shaderName, attribute, args));
    }

    // Set enabled attributes
    this.buffers[this.getBufferName(shaderName, 'vertex')].setAttribPointers(gl, glShader, offset);
};

/**
 * Restore the state of the attribute pointers in a WebGL context
 * @private
 * @param gl The WebGL context
 * @param shader The active WebGL shader
 */
Bucket.prototype.unsetAttribPointers = function(shaderName, gl, glShader) {
    var attributes = this.shaders[shaderName].attributes;

    // Set disabled attributes
    for (var i = 0; i < attributes.length; i++) {
        var attribute = attributes[i];
        var glAttribute = glShader['a_' + attribute.name];
        if (attribute.isDisabled && attribute.isDisabled.call(this)) {
            gl.enableVertexAttribArray(glAttribute);
        }
    }
};

var _getAttributeValueCache = {};
// TODO break the function creation logic into a separate function
Bucket.prototype._getAttributeValue = function(shaderName, attribute, args) {
    if (!_getAttributeValueCache[shaderName]) _getAttributeValueCache[shaderName] = {};

    if (!_getAttributeValueCache[shaderName][attribute.name]) {
        var bodyArgs = this.shaders[shaderName].attributeArgs;
        var body = 'return ';
        if (Array.isArray(attribute.value)) {
            body += '[' + attribute.value.join(', ') + ']';
        } else {
            body += attribute.value;
        }
        _getAttributeValueCache[shaderName][attribute.name] = new Function(bodyArgs, body);
    }

    var value = _getAttributeValueCache[shaderName][attribute.name].apply(this, args);

    if (attribute.multiplier) {
        return value.map(function(v) { return v * attribute.multiplier; });
    } else {
        return value;
    }
};

/**
 * Get the name of the method used to add an item to a buffer.
 * @param {string} shaderName The name of the shader that will use the buffer
 * @param {string} type One of "vertex", "element", or "secondElement"
 * @returns {string}
 */
Bucket.prototype.getAddMethodName = function(shaderName, type) {
    return 'add' + capitalize(shaderName) + capitalize(type);
};

/**
 * Get the name of a buffer.
 * @param {string} shaderName The name of the shader that will use the buffer
 * @param {string} type One of "vertex", "element", or "secondElement"
 * @returns {string}
 */
Bucket.prototype.getBufferName = function(shaderName, type) {
    return shaderName + capitalize(type);
};

Bucket.prototype.serialize = function() {
    return {
        layer: this.layer.serialize(),
        zoom: this.zoom,
        elementGroups: this.elementGroups
    };
};

Bucket.prototype._premultiplyColor = util.premultiply;


var createVertexAddMethodCache = {};
function createVertexAddMethod(shaderName, shader, bufferName, enabledAttributes) {
    var body = '';

    var pushArgs = [];
    for (var i = 0; i < enabledAttributes.length; i++) {
        var attribute = enabledAttributes[i];

        var attributePushArgs = [];
        if (Array.isArray(attribute.value)) {
            attributePushArgs = attribute.value;
        } else {
            var attributeId = '_' + i;
            body += 'var ' + attributeId + ' = ' + attribute.value + ';';
            for (var j = 0; j < attribute.components; j++) {
                attributePushArgs.push(attributeId + '[' + j + ']');
            }
        }

        var multipliedAttributePushArgs;
        if (attribute.multiplier) {
            multipliedAttributePushArgs = [];
            for (var k = 0; k < attributePushArgs.length; k++) {
                multipliedAttributePushArgs[k] = attributePushArgs[k] + '*' + attribute.multiplier;
            }
        } else {
            multipliedAttributePushArgs = attributePushArgs;
        }

        pushArgs = pushArgs.concat(multipliedAttributePushArgs);
    }

    body += 'return this.buffers.' + bufferName + '.push(' + pushArgs.join(',') + ');';

    if (!createVertexAddMethodCache[body]) {
        createVertexAddMethodCache[body] = new Function(shader.attributeArgs, body);
    }

    return createVertexAddMethodCache[body];
}

function createElementAddMethod(buffer) {
    return function(one, two, three) {
        return buffer.push(one, two, three);
    };
}

function createElementBuffer(components) {
    return new Buffer({
        type: Buffer.BufferType.ELEMENT,
        attributes: [{
            name: 'vertices',
            components: components || 3,
            type: Buffer.ELEMENT_ATTRIBUTE_TYPE
        }]
    });
}

function capitalize(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}
