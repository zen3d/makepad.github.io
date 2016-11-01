var painter = require('services/painter')
var types = require('base/types')
var parser = require('parsers/js')
var ShaderInfer = require('base/infer')

for(let i = 0; i < 16; i++) painter.nameId('ATTR_'+i)

const compName = ['x','y','z','w']

module.exports = class Compiler extends require('base/class'){

	prototype(){
		this.$mapExceptions = true
		this.$uniformHeader = ""
		this.$pixelHeader = ""
		this.$vertexHeader = ""

		this.inheritable('props', function(){
			var props = this.props
			for(let key in props){
				if(!this.$defineProp)debugger
				this.$defineProp(key, props[key])
			}
		})

		this.inheritable('defines', function(){
			var defines = this.defines
			if(!this.hasOwnProperty('_defines')){
				this._defines = this._defines? Object.create(this._defines): {}
			}
			for(let key in defines){
				this._defines[key] = defines[key]
			}
		})

		this.inheritable('requires', function(){
			var requires = this.requires
			if(!this.hasOwnProperty('_requires')){
				this._requires = this._requires? Object.create(this._requires): {}
			}
			for(let key in requires){
				this._requires[key] = requires[key]
			}
		})

		this.inheritable('structs', function(){
			var structs = this.structs
			if(!this.hasOwnProperty('_structs')){
				this._structs = this._structs?Object.create(this._structs):{}
			}
			for(let key in structs){
				var struct = structs[key]
				// auto name the struct based on the key
				if(!struct.name){
					var newstruct = Object.create(struct)
					newstruct.constructor = struct.constructor
					newstruct.name = key
					struct = newstruct
				}
				this._structs[key] = struct
			}
		})

		this.inheritable('verbs', function(){
			var verbs = this.verbs
			if(!this.hasOwnProperty('_verbs')) this._verbs = this._verbs?Object.create(this._verbs):{}
			for(let key in verbs) this._verbs[key] = verbs[key]
		})
	}

	$defineProp(key, value){
		if(!this.hasOwnProperty('_props')){
			this._props = this._props?Object.create(this._props):{}
		}

		var config = value
		if(typeof config !== 'object' || config.constructor !== Object){
			config = {value:config}
		}

		var old = this._props[key]
		if(old){
			for(let key in old) if(!(key in config)){
				config[key] = old[key]
			}
		}

		this._props[key] = config
		if(config.value !== undefined) this[key] = config.value
		if(!config.type) config.type = types.typeFromValue(config.value)
		if(!config.kind) config.kind = 'instance'		
	}

	onCompileVerbs(){
		this.__initproto__()
		if(!this.$methodDeps){
			this.$compileShader()
		}
		else{
			// figure out if we need to compile
			var recompile = false
			if(this.hasOwnProperty('$methodDeps')){
				return // shaders are class things
			}
			var deps = this.$methodDeps
			for(let key in deps){
				if(this[key] !== deps[key]){
					this.$compileShader()
					return
				}
			}
		}
	}

	$compileShader(){
		this.$methodDeps = {}
		var vtx = ShaderInfer.generateGLSL(this, this.vertexMain, null, this.$mapExceptions)
		var pix = ShaderInfer.generateGLSL(this, this.pixelMain, vtx.varyOut, this.$mapExceptions)

		if(vtx.exception || pix.exception) return

		var inputs = {}, geometryProps = {}, instanceProps = {}, styleProps = {}, uniforms = {}
		for(let key in vtx.geometryProps) inputs[key] = geometryProps[key] = vtx.geometryProps[key]
		for(let key in pix.geometryProps) inputs[key] = geometryProps[key] = pix.geometryProps[key]
		for(let key in vtx.instanceProps) inputs[key] = styleProps[key] = instanceProps[key] = vtx.instanceProps[key]
		for(let key in pix.instanceProps) inputs[key] = styleProps[key] = instanceProps[key] = pix.instanceProps[key]
		for(let key in vtx.uniforms) uniforms[key] = vtx.uniforms[key]
		for(let key in pix.uniforms){
			var uni = pix.uniforms[key]
			if(uniforms[key]) uniforms[key].refcount += uni.refcount
			else uniforms[key] = uni
		}

		// the shaders
		var vhead = this.$vertexHeader, vpre = '', vpost = ''
		var phead = this.$pixelHeader, ppre = '', ppost = ''

		// Unpack and tween props
		vhead += '// prop attributes\n'

		var tweenrep = ''

		// calc prop size
		var totalslots = 0

		for(let key in instanceProps){
			var prop = instanceProps[key]
			var slots = prop.type.slots
			if(prop.config.pack){
				if(prop.type.name === 'vec4'){
					slots = 2
				}
				else if(prop.type.name === 'vec2'){
					slots = 1
				}
				else throw new Error('Cant use packing on non vec2 or vec4 type for '+key)
			}
			prop.offset = totalslots
			prop.slots = slots
			totalslots += slots
			if(!prop.config.noTween) totalslots += slots
		}

		function propSlot(idx){
			var slot = Math.floor(idx/4)
			var ret = 'ATTR_' +  slot
			if(lastslot !== slot || totalslots%4 !== 1) ret += '.' + compName[idx%4]
			return ret
		}

		// Unpack attributes
		var lastslot = Math.floor(totalslots/4)
		var propSlots = 0
		for(let key in instanceProps){
			var prop = instanceProps[key]
			var slots = prop.slots
			// lets create the unpack / mix code here
			propSlots += slots
			var pack = prop.config.pack
			if(pack){
				if(prop.type.name === 'vec2'){
					if(prop.config.noTween){
						vpre += '\t' + key + ' = vec2('
						var start = propSlots - slots
						var p1 = propSlot(start)
						vpre += 'floor('+p1+'/4096.0)'
						vpre += ',mod('+p1+',4096.0)'
						if(pack === 'float12') vpre += ')/4095.0;\n'
						else vpre += ');\n'
					}
					else{
						propSlots += slots
						tweenrep += '\t' + key + ' = mix(vec2('
						var start1 = propSlots - slots
						var start2 = propSlots - slots*2
						var p1 = propSlot(start1)
						var p3 = propSlot(start2)
						tweenrep += 'floor('+p1+'/4096.0)' 
						tweenrep += ',mod('+p1+',4096.0)' 
						tweenrep += '),vec2('
						tweenrep += 'floor('+p3+'/4096.0)'
						tweenrep += ',mod('+p3+',4096.0)'
						if(pack === 'float12') tweenrep += '),T)/4095.0;\n'
						else if(pack === 'int12') tweenrep += '),T)-2048.0;\n'
						else tweenrep += '),T);\n'
					}
				}
				else{
					if(prop.config.noTween){
						vpre += '\t' + key + ' = vec4('
						var start = propSlots - slots
						var p1 = propSlot(start)
						var p2 = propSlot(start+1)
						vpre += 'floor('+p1+'/4096.0)'
						vpre += ',mod('+p1+',4096.0)'
						vpre += ',floor('+p2+'/4096.0)' 
						vpre += ',mod('+p2+',4096.0)' 
						if(pack === 'float12') vpre += ')/4095.0;\n'
						else if(pack === 'int12') vpre += ')-2048.0;\n'
						else vpre += ');\n'
					}
					else{
						propSlots += slots
						tweenrep += '\t' + key + ' = mix(vec4('
						var start1 = propSlots - slots
						var start2 = propSlots - slots*2
						var p1 = propSlot(start1)
						var p2 = propSlot(start1+1)
						var p3 = propSlot(start2)
						var p4 = propSlot(start2+1)
						tweenrep += 'floor('+p1+'/4096.0)' 
						tweenrep += ',mod('+p1+',4096.0)' 
						tweenrep += ',floor('+p2+'/4096.0)'
						tweenrep += ',mod('+p2+',4096.0)'
						tweenrep += '),vec4('
						tweenrep += 'floor('+p3+'/4096.0)'
						tweenrep += ',mod('+p3+',4096.0)'
						tweenrep += ',floor('+p4+'/4096.0)'
						tweenrep += ',mod('+p4+',4096.0)'
						if(pack === 'float12') tweenrep += '),T)/4095.0;\n'
						else if(pack === 'int12') tweenrep += '),T)-2048.0;\n'
						else tweenrep += '),T);\n'
					}
				}
			}
			else{
				if(prop.config.noTween){
					var vdef = prop.type.name + '('
					if(vdef === 'float(') vdef = '('
					for(let i = 0, start = propSlots - slots; i < slots; i++){
						if(i) vdef += ', '
						vdef += propSlot(start + i)
					}
					vdef += ')'
					vpre += '\t' + key + ' = ' + vdef + ';\n'
				}
				else{
					propSlots += slots
					var vnew = prop.type.name + '('
					if(vnew === 'float(') vnew = '('
					var vold = vnew
					for(let i = 0, start1 = propSlots - slots, start2 = propSlots - slots*2; i < slots; i++){
						if(i) vnew += ', ', vold += ', '
						vnew += propSlot(start1 + i)
						vold += propSlot(start2 + i)
					}
					vnew += ')'
					vold += ')'
					tweenrep += '\t' + key + ' = mix(' + vnew + ',' + vold + ',T);\n'
				}
			}
		}

		var attrid = 0
		for(let i = totalslots, pid = 0; i > 0; i -= 4){
			if(i >= 4) vhead += 'attribute vec4 ATTR_'+(attrid)+';\n'
			if(i == 3) vhead += 'attribute vec3 ATTR_'+(attrid)+';\n'
			if(i == 2) vhead += 'attribute vec2 ATTR_'+(attrid)+';\n'
			if(i == 1) vhead += 'attribute float ATTR_'+(attrid)+';\n'
			attrid++
		}

		for(let key in geometryProps){
			var geom = geometryProps[key]
			var slots = geom.type.slots

			if(slots > 4){
				var v1 = geom.type.name + '('
				if(v1 === 'float(') v1 = '('
				vpre += '\t' + key + ' = ' + v1
				for(let i = 0; i < slots; i++){
					if(i) vpre += ', '
					vpre += '\tATTR_' + (attrpid + Math.floor(i/4)) + '.' + compName[i%4]
				}
				vpre += ');\n'

				for(let i = slots, pid = 0; i > 0; i -= 4){
					if(i >= 4) vhead = 'attribute vec4 ATTR_'+(attrid)+';\n' + vhead
					if(i == 3) vhead = 'attribute vec3 ATTR_'+(attrid)+';\n' + vhead
					if(i == 2) vhead = 'attribute vec2 ATTR_'+(attrid)+';\n' + vhead
					if(i == 1) vhead = 'attribute float ATTR_'+(attrid)+';\n' + vhead
					attrid ++
				}
			}
			else{
				vpre += '\t' + key + ' = ATTR_' + attrid + ';\n'
				vhead = 'attribute '+geom.type.name+' ATTR_' + attrid + ';\n' + vhead
				attrid++
			}
		}
		vhead = '// mesh attributes\n' + vhead

		// define structs
		for(let key in vtx.structs){
			var struct = vtx.structs[key]
			// lets output the struct
			vhead += '\nstruct ' + key + '{\n'
			var fields = struct.fields
			for(let fieldname in fields){
				var field = fields[fieldname]
				vhead += '	'+field.name +' '+fieldname+';\n'
			}
			vhead += '};\n'
		}

		for(let key in pix.structs){
			var struct = pix.structs[key]
			// lets output the struct
			phead += '\nstruct ' + key + '{\n'
			var fields = struct.fields
			for(let fieldname in fields){
				var field = fields[fieldname]
				phead += '	'+field.name +' '+fieldname+';\n'
			}
			phead += '};\n'
		}

		// define the input variables
		vhead += '\n// inputs\n'
		for(let key in inputs){
			var input = inputs[key]
			vhead += input.type.name + ' ' + key + ';\n'
		}

		// define the varying targets
		for(let key in vtx.varyOut){
			var vary = vtx.varyOut[key]
			vhead += vary.type.name + ' ' + key + ';\n'
		}

		// lets pack/unpack varying and props and attributes used in pixelshader
		var allvary = {}
		for(let key in pix.geometryProps) allvary[key] = pix.geometryProps[key]
		for(let key in pix.varyOut) allvary[key] = pix.varyOut[key]
		for(let key in pix.instanceProps) allvary[key] = pix.instanceProps[key]

		// make varying packing and unpacking
		var vid = 0, curslot = 0, varystr = ''
		var varyslots = 0
		for(let key in allvary){
			var prop = allvary[key]
			var type = prop.type
			var slots = type.slots

			// define the variables in pixelshader
			if(curslot === 0) phead += '// inputs\n'
			phead += type.name + ' ' + key + ';\n'
			varyslots += slots

			// pack the varying
			for(let i = 0; i < slots; i++, curslot++){
				// lets allocate a slot
				if(curslot%4 === 0){
					if(curslot === 0){
						vhead += '\n//varyings\n'
						phead += '\n//varyings\n'
					}
					vhead += 'varying vec4 VARY_'+vid+';\n'
					phead += 'varying vec4 VARY_'+vid+';\n'
					if(curslot>=4) vpost += ');\n'
					vpost += '\tVARY_'+vid+' = vec4('
					vid++
				}
				else vpost += ','
				if(slots === 1){
					vpost += key
				}
				else{
					vpost += key + '[' + i + ']'
				}
			}

			// unpack the varying into variable in pixelshader
			var start = curslot - slots
			var v1 = prop.type.name + '('
			if(v1 === 'float(') v1 = '('
			ppre += '\t' + key + ' = ' + v1
			for(let i = 0; i < slots; i++){
				if(i) ppre += ', '
				ppre += 'VARY_'+Math.floor((i+start)/4) + '.' + compName[(i+start)%4]
			}
			ppre += ');\n'
		}
		for(let i =(4 - curslot%4)%4 - 1; i >= 0; i--){
			vpost += ',0.'
		}
		if(curslot) vpost += ');\n'

		vhead += this.$uniformHeader
		vhead += '\n// uniforms\n'
		phead += this.$uniformHeader
		phead += '\n// uniforms\n'

		// create uniformBlocks
		var uboDefs = {}
		var props = this._props
		for(let key in props){
			var prop = props[key]
			if(prop.kind === 'uniform'){
				let blockName = prop.block
				var uniName = 'this_DOT_'+ key
				if(!blockName || blockName === 'draw'){
					// if the draw uniform is not used skip it
					if(!(uniName in uniforms)) continue
					blockName = 'draw'
				}
				var block = uboDefs[blockName] || (uboDefs[blockName] = {})
				block[uniName] = uniforms[uniName] || {type:prop.type, config:prop, name:key, unused:true}
			}
		}

		for(let blockName in uboDefs){
			var block = uboDefs[blockName]
			vhead += '// Uniform block '+blockName+';\n'
			phead += '// Uniform block '+blockName+';\n'
			for(let key in block){
				var uniform = block[key]
				vhead += 'uniform ' + uniform.type.name + ' ' + key + ';\n'
				phead += 'uniform ' + uniform.type.name + ' ' + key + ';\n'
			}
		}

		// the sampler uniforms
		var hassamplers = 0
		var samplers = {}
		for(let key in vtx.samplers){
			var sampler = samplers[key] = vtx.samplers[key].sampler
			if(!hassamplers++)vhead += '\n// samplers\n'
			vhead += 'uniform ' + sampler.type.name + ' ' + key + ';\n'
		}

		var hassamplers = 0
		for(let key in pix.samplers){
			var sampler = samplers[key] = pix.samplers[key].sampler
			if(!hassamplers++)phead += '\n// samplers\n'
			phead += 'uniform ' + sampler.type.name + ' ' + key + ';\n'
		}

		// define output variables in pixel shader
		phead += '\n// outputs\n'
		for(let key in pix.outputs){
			var output = pix.outputs[key]
			phead += output.name + ' ' + key + ';\n'
		}

		// how do we order these dependencies so they happen top down
		var vfunc = ''
		for(let i = 0; i < vtx.genFunctions.length; i++){//key in vtx.genFunctions){
			var fn =  vtx.genFunctions[i].value
			vfunc = '\n'+fn.code + '\n' + vfunc
		}

		/*
		if(vtx.genFunctions.this_DOT_vertex_T.return.type !== types.vec4){
			vtx.mapException({
				state:{
					curFunction:vtx.genFunctions.this_DOT_vertex_T
				},
				type:'generate',
				message:'vertex function not returning a vec4',
				node:vtx.genFunctions.this_DOT_vertex_T.ast
			})
		}*/

		var vertex = vhead 
		vertex += vfunc
		vertex += '\nvoid main(){\n'
		vertex += vpre
		vertex += vtx.main.replace("\t$CALCULATETWEEN",tweenrep)
		vertex += vpost
		vertex += '}\n'

		var pfunc = ''
		for(let i = 0; i < pix.genFunctions.length; i++){//key in pix.genFunctions){
			var fn = pix.genFunctions[i].value
			pfunc = '\n'+fn.code + '\n' + pfunc
		}
		var pixel = phead
		pixel += pfunc
		pixel += '\nvoid main(){\n'
		pixel += ppre
		pixel += pix.main
		//!TODO: do MRT stuff
		pixel += ppost + '}\n'

		// add all the props we didnt compile but we do need for styling to styleProps
		for(let key in this._props){
			var config = this._props[key]
			var propname = 'this_DOT_' + key
			if(config.styleLevel && !styleProps[propname]){
				styleProps[propname] = {
					name:key,
					config:config
				}
			}
		}

		if(vtx.exception || pix.exception){
			return
		}

		var info = this.$compileInfo = {
			name:this.name || this.constructor.name,
			trace:this.drawTrace,
			instanceProps:instanceProps,
			geometryProps:geometryProps,
			styleProps:styleProps,
			uniforms:uniforms,
			uboDefs:uboDefs,
			samplers:samplers,
			vertex:vertex,
			pixel:pixel,
			propSlots:propSlots
		}

		this.$toolCacheKey = pixel+vertex
		if(this.dump) console.log(vertex,pixel)

		// push our compilation up the protochain as far as we can
		var proto = Object.getPrototypeOf(this)
		var deps = this.$methodDeps
		while(proto){
			for(let key in deps){
				if(deps[key] !== proto[key]) return
			}
			// write it
			proto.$compileInfo = info
			proto.$methodDeps = deps
			proto = Object.getPrototypeOf(proto)
		}
	}


	/*
	function styleTweenCode(indent, inobj){
		var code = ''
		code += indent+'if(_tween === undefined) _tween = '+inobj+'.tween\n'
		code += indent+'if(_duration === undefined) _duration = '+inobj+'.duration\n'
		code += indent+'if(_delay === undefined) _delay = '+inobj+'.delay\n'
		code += indent+'if(_ease === undefined) _ease = '+inobj+'.ease\n'
		return code
	}*/

	$STYLEPROPS(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		// first generate property overload stack
		// then write them on the turtles' propbag
		var styleProps = this.$compileInfo.styleProps
		if(!macroargs) throw new Error('$STYLEPROPS doesnt have overload argument')

		// lets make the vars
		var code = indent + 'var $turtle = this.turtle'
		var styleLevel = macroargs[1]
		for(let key in styleProps){
			var prop = styleProps[key]
			if(prop.config.noStyle) continue
			if(styleLevel && prop.config.styleLevel > styleLevel) continue
			code += ', _' + prop.name
		}
		code += '\n\n'
		code += 'if(' + macroargs[0] + ' === this){\n'
		code += styleStampRootCode('	', macroargs[0], target._props, styleProps, styleLevel)
		code += '}\n'
		code += 'else if(' + macroargs[0] + '){\n'
		code += stylePropCode('	', macroargs[0], styleProps, styleLevel, true)
		code += '}\n'

		code += 'var $p1 = this.$outerState && this.$outerState.'+classname+'\n'
		code += 'if($p1){\n'
		code += stylePropCode('	', '$p1', styleProps, styleLevel)
		code += '}\n'

		code += 'var $p2 = this._state && this._state.'+classname+'\n'
		code += 'if($p2){\n'
		code += stylePropCode('	', '$p2', styleProps, styleLevel)
		code += '}\n'

		code += 'var $p0 = this.$stampArgs && this.$stampArgs.'+classname+'\n'
		code += 'if($p0){\n'
		code += stylePropCode('	', '$p0', styleProps, styleLevel)
		code += '}\n'

		/*
		if(styleProps.this_DOT_tween){
			code += 'var $p3 = this.$stampArgs\n'
			code += 'if($p3){\n'
			code += styleTweenCode('	', '$p3')
			code += '}\n'

			code += 'var $p4 = this.$outerState\n'
			code += 'if($p4){\n'
			code += styleTweenCode('	', '$p4')
			code += '}\n'

			code += 'var $p5 = this._state\n'
			code += 'if($p5){\n'
			code += styleTweenCode('	', '$p5')
			code += '}\n'

			code += styleTweenCode('', 'this')
		}
		*/
		// last one is the class
		code += 'var $p9 = this.'+classname+'.prototype\n\n'
		code += stylePropCode('', '$p9', styleProps, styleLevel)

		//console.log(code)
		// store it on the turtle
		code += '\n'
		for(let key in styleProps){
			var prop = styleProps[key]
			var name = prop.name
			if(prop.config.noStyle) continue
			if(macroargs[1] && prop.config.styleLevel > macroargs[1]) continue
			// store on turtle
			code += indent + '$turtle._' + name +' = _' + name + '\n'
		}
		return code
	}

	$ALLOCDRAW(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		// lets generate the draw code.
		// what do we do with uniforms?.. object ref them from this?
		// lets start a propsbuffer 
		var info = this.$compileInfo
		var code = ''
		
		var need = macroargs[0] || 1
		var fastWrite = macroargs[1]

		code += indent+'var $view = this.view\n'
		code += indent+'var $shader = this.$shaders.'+classname+' || this.$allocShader("'+classname+'")\n'
		code += indent+'var $props = $shader.$props\n'
		code += indent+'var $proto = this.' + classname +'.prototype\n'
		code += indent+'if($props.$frameId !== $view._frameId && !$view.$inPlace){\n'
		code += indent+'	$props.$frameId = $view._frameId\n'
		code += indent+'	$props.oldLength = $props.length\n'
		code += indent+'	$props.updateMesh()\n'
		code += indent+'	$props.length = 0\n'
		code += indent+'	$props.dirty = true\n'
		code += indent+'	\n'
		code += indent+'	var $todo = $view.todo\n'
		code += indent+'	var $drawUbo = $shader.$drawUbo\n'
		code += indent+'	$todo.useShader($shader)\n'

		// lets set the blendmode
		code += '	$todo.blending($proto.blending, $proto.constantColor)\n'

		// set the vao
		code += '	$todo.vao($shader.$vao)\n'

		// set uniforms
		var uniforms = info.uniforms
		var drawUboDef = info.uboDefs.draw
		code += '	$todo.ubo('+painter.nameId('painter')+', $view.app.painterUbo)\n'
		code += '	$todo.ubo('+painter.nameId('todo')+', $todo.todoUbo)\n'
		code += '	$todo.ubo('+painter.nameId('draw')+', $drawUbo)\n'

		for(let key in uniforms){
			var uniform = uniforms[key]
			
			if(key === 'this_DOT_time' && uniform.refcount > 1){
				code += indent +'	$todo.timeMax = Infinity\n'
			}
			if(!drawUboDef || !(key in drawUboDef)) continue
			var thisname = key.slice(9)
			var source = mainargs[0]+' && '+mainargs[0]+'.'+thisname+' || $view.'+ thisname +'|| $proto.'+thisname
			var typename = uniform.type.name
			if(uniform.config.animate){
			 	code += indent+'    var $animate = '+source+'\n'
				code += indent+'    if($animate[0]+$animate[1] > $todo.timeMax) $todo.timeMax = $animate[0]+$animate[1]\n'
			 	code += indent+'	$drawUbo.'+typename+'('+painter.nameId(key)+',$animate)\n'
			}
			else code += indent+'	$drawUbo.'+typename+'('+painter.nameId(key)+','+source+')\n'
		}

		// do the samplers
		var samplers = info.samplers
		for(let key in samplers){
			var sampler = samplers[key]

			var thisname = key.slice(9)
			var source = mainargs[0]+' && '+mainargs[0]+'.'+thisname+' || $proto.'+thisname

			code += indent +'	$todo.sampler('+painter.nameId(key)+','+source+',$proto.$compileInfo.samplers.'+key+')\n'
		}
		// lets draw it
		code += indent + '	$todo.drawArrays('+painter.TRIANGLES+')\n'
		code += indent + '}\n'
		code += indent + 'var $propslength = $props.length\n\n'
		code += indent + 'var $need = min($propslength + '+need+',$proto.propAllocLimit)\n'
		code += indent + 'if($need > $props.allocated && $need) $props.alloc($need)\n'
		if(!fastWrite){
			code += indent + 'var $writelevel = (typeof _x === "number" && !isNaN(_x) || typeof _x === "string" || typeof _y === "number" && !isNaN(_y) || typeof _y === "string")?$view.$turtleStack.len - 1:$view.$turtleStack.len\n'
			code += indent + '$view.$writeList.push($props, $propslength, $need, $writelevel)\n'
			
			if(target.$isStamp){
				code += indent + 'if(this.$propsId'+classname+' !== $view._frameId){\n'
				code += indent + '	this.$propsId'+classname+' = $view._frameId\n'
				code += indent + '	this.$propsLen'+classname+' = $propslength\n'
				code += indent + '}\n'
			}
		}
		else{
			code += indent + 'var $a = $props.array\n'
			code += indent + '$props.dirty = true\n'
		}
		code += indent + 'var $turtle = this.turtle\n'
		code += indent + '$turtle.$propoffset = $propslength\n'
		code += indent + '$props.length = $need\n'

		return code
	}

	$DUMPPROPS(){
		var code = ''
		var instanceProps = this.$compileInfo.instanceProps
		for(let key in instanceProps){
			var prop = instanceProps[key]
			var slots = prop.slots
			var o = prop.offset
			var notween = prop.config.noTween
			if(!notween){
				// new, old
				for(let i = 0; i < slots; i++){
					code += 'console.log("'+(prop.name+(slots>1?i:''))+' "+$a[$o+'+(o+i+slots)+']+"->"+$a[$o+'+(o+i)+'])\n'
				}
			}
			else{
				for(let i = 0; i < slots; i++){
					code +=  'console.log("'+(prop.name+(slots>1?i:''))+' "+$a[$o+'+(o+i)+'])\n'
				}
			}
		}
		return code
	}

	$PREVPROPS(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		var code = ''
		var info = this.$compileInfo
		code += indent +'var $props =  this.$shaders.'+classname+'.$props\n'
		code += indent +'var $a = $props.array\n'
		code += indent +'var $o = (this.turtle.$propoffset - 1) * ' + info.propSlots +'\n'
		var instanceProps = info.instanceProps
		var argobj = macroargs[0]
		for(let key in argobj){
			var prop = instanceProps['this_DOT_'+key]
			// lets write prop
			if(prop.config.pack) throw new Error('Please implement PREVPROP packing support '+key)
			if(prop.config.type.slots>1) throw new Error('Please implement PREVPROP vector support '+key)

			code += indent + '$a[$o+'+prop.offset+'] = ' +argobj[key] +'\n'
		}
		return code
	}

	$PROPLEN(target, classname, macroargs, mainargs, indent){
		return 'this.$shaders.'+classname+'.$props.length'
	}

	$PROPVARDEF(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		var code = ''
		var info = this.$compileInfo
	
		code += indent +'var $props = this.$shaders.'+classname+'.$props\n'
		code += indent +'var $a = $props.array\n'

		return code
	}

	$PROP(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		var code = ''
		var info = this.$compileInfo
		var prop = info.instanceProps['this_DOT_'+macroargs[1].slice(1,-1)]
		return '$a[(' + macroargs[0] + ')*'+ info.propSlots +'+'+prop.offset+']'
	}

	$PREV(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		var code = ''
		var info = this.$compileInfo
		if(info.noTween) throw new Error('Property ' + macroargs[1] + ' does not tween')
		var prop = info.instanceProps['this_DOT_'+macroargs[1].slice(1,-1)]
		return '$a[(' + macroargs[0] + ')*'+ info.propSlots +'+'+(prop.offset+prop.type.slots)+']'
	}

	$WRITEPROPS(target, classname, macroargs, mainargs, indent){
		if(!this.$compileInfo) return ''
		// load the turtle

		var fastWrite = typeof macroargs[0] === 'object'?macroargs[0].$fastWrite:false

		var hasTweenDelta = macroargs[0].$tweenDelta
		var info = this.$compileInfo
		var instanceProps = info.instanceProps
		var code = ''
		code += indent + 'var $turtle = this.turtle\n'

		if(!fastWrite){
			code += indent + 'var $view = this.view\n'
			code += indent + 'var $inPlace = $view.$inPlace\n\n'
			code += indent +'var $proto = this.' + classname +'.prototype\n'
			code += indent +'var $shader = this.$shaders.'+classname+'\n'
			code += indent +'var $props = $shader.$props\n'
			code += indent +'var $a = $props.array\n'
			code += indent + '$props.dirty = true\n'
		}

		if(macroargs[0].$offset){
			code += indent +'var $o = ('+macroargs[0].$offset+') * ' + info.propSlots +'\n'
		}
		else{
			if(!fastWrite){
				code += indent +'var $o = $turtle.$propoffset++ * ' + info.propSlots +'\n'
			}
			else{
				code += indent +'var $o = $propslength++ * ' + info.propSlots +'\n'
			}
		}

		if(hasTweenDelta){
			code += indent +'var $tweenDelta = (' + macroargs[0].$tweenDelta + ') * '+info.propSlots+'\n'
			code += indent +'var $fwdTween =  $o - $tweenDelta\n'
		}
		//code += indent +'var $changed = false\n'
		var tweencode = '	var $f = $time, $1mf = 1.-$time, $upn, $upo\n'
		tweencode += '	var $cf = Math.min(1.,Math.max(0.,$time)), $1mcf = 1.-$cf\n'
		
		var isAnimate = macroargs[0].$animate

		var propcode = ''
		var deltafwd = ''
		var copyfwd = ''
		var copyprev = ''
		// lets generate the tween
		for(let key in instanceProps){
			var prop = instanceProps[key]
			var slots = prop.slots
			var o = prop.offset
			var notween =  prop.config.noTween
			var noInPlace = fastWrite?false:prop.config.noInPlace
			propcode += '\n'+indent+'// '+key + '\n'
			// generate the code to tween.
			if(!notween){
				// new, old
				if(noInPlace) tweencode += indent + 'if(!$inPlace){\n'

				tweencode += '\n'+indent+'	//' + key + '\n'

				var pack = prop.config.pack
				if(pack){
					// we have to unpack before interpolating
					for(let i = 0; i < slots; i++){
						tweencode += indent + 'var _upn = $a[$o+'+(o + i)+'], _upo = $a[$o+'+(o + i + slots)+']\n'
						tweencode += indent + '$a[$o+'+(o +i)+'] = ' +
							'(($1mcf * Math.floor(_upo/4096) +' +
							'$cf * Math.floor(_upn/4096)) << 12) + ' + 
							'(($1mcf * (_upo%4096) +' +
							'$cf * (_upn%4096))|0)\n'
						if(hasTweenDelta){
							deltafwd += indent + '$a[$o+'+(o + i + slots)+'] = $a[$o+'+(o +i)+'+$tweenDelta]\n'
							copyfwd += indent + '$a[$fwdTween+'+(o + i + slots)+'] = $a[$o+'+(o +i)+']\n'
						}
						copyprev += indent + '$a[$o+'+(o + i + slots)+'] = $a[$o+'+(o +i)+']\n'
					}
				}
				else{

					for(let i = 0; i < slots; i++){
						//if(key === 'this_DOT_open') tweencode += 'if($o===2*' + info.propSlots +')console.error($duration,$cf, $a[$o+'+(o +i)+'])\n'

						tweencode += indent + '	$a[$o+'+(o +i)+'] = ' +
							'$1mcf * $a[$o+'+(o + i + slots)+'] + ' +
							'$cf * $a[$o+'+(o +i)+']\n'

						if(hasTweenDelta){
							deltafwd += indent + '$a[$o+'+(o + i + slots)+'] = $a[$o+'+(o +i)+'+$tweenDelta]\n'
							copyfwd += indent + '$a[$fwdTween+'+(o + i + slots)+'] = $a[$o+'+(o +i)+']\n'
						}
						copyprev += indent + '$a[$o+'+(o + i + slots)+'] = $a[$o+'+(o +i)+']\n'
					}
				}
				if(noInPlace) tweencode += indent + '}\n'
			}

			// assign properties
			// check if we are a vec4 and typeof string

			var propsource = '$turtle._' + prop.name

			if(prop.name === 'tweenStart'){
				if(macroargs[0].delay) propsource = '($tweenStart !== 0?$view._time +'+macroargs[0].delay+':-Infinity)'
				else propsource = '($tweenStart !== 0?$view._time + $turtle._delay:-Infinity)'
			}
			if(typeof macroargs[0] === 'object'){
				var marg = macroargs[0][prop.name]
				if(marg) propsource = marg
				else if(prop.name !== 'tweenStart' && fastWrite) continue
			}

			if(isAnimate && !(prop.name in macroargs[0]) && prop.name !== 'tweenStart'){
				continue
			}

			if(noInPlace){
				propcode += indent + 'if(!$inPlace){\n'
			}

			if(prop.type.name === 'vec4'){
				// check packing
				var pack = prop.config.pack
				if(pack){
					propcode += indent + 'var _' + prop.name + ' = '+ propsource +'\n'
					if(pack === 'float12'){
						if(prop.config.noCast){
							propcode += indent +'$a[$o+'+(o)+']=((_'+prop.name+'[0]*4095)<<12) + ((_'+prop.name+'[1]*4095)|0),$a[$o+'+(o+1)+']=((_'+prop.name+'[2] * 4095)<<12) + ((_'+prop.name+'[3]*4095)|0)\n'
						}
						else{
							propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
							propcode += indent + '	if(_'+prop.name+'.length === 4)$a[$o+'+(o)+']=((Math.min(_'+prop.name+'[0],1.)*4095)<<12) + ((Math.min(_'+prop.name+'[1],1.)*4095)|0),$a[$o+'+(o+1)+']=((Math.min(_'+prop.name+'[2],1.) * 4095)<<12) + ((Math.min(_'+prop.name+'[3],1.)*4095)|0)\n'
							propcode += indent + '	else if(_'+prop.name+'.length === 2)this.$parseColorPacked(_'+prop.name+'[0], _'+prop.name+'[1],$a,$o+'+o+')\n'
							propcode += indent + '	else if(_'+prop.name+'.length === 1)$a[$o+'+o+']=$a[$o+'+(o+1)+']=((_'+prop.name+'[0]*4095)<<12) + ((_'+prop.name+'[0]*4095)|0)\n'
							propcode += indent + '}\n'
							propcode += indent + 'if(typeof _'+prop.name+' === "string")this.$parseColorPacked(_'+prop.name+',1.0,$a,$o+'+o+')\n'
							propcode += indent + 'else if(typeof _'+prop.name+' === "number")$a[$o+'+o+']=$a[$o+'+(o+1)+']=((_'+prop.name+'*4095)<<12) + ((_'+prop.name+'*4095)|0)\n'
						}
					}
					else{ // int packing
						if(prop.config.noCast){
							propcode += indent +'$a[$o+'+(o)+']=(_'+prop.name+'[0]+2048<<12) + (_'+prop.name+'[1]+2048|0),$a[$o+'+(o+1)+']=(_'+prop.name+'[2]+2048<<12) + (_'+prop.name+'[3]+2048|0)\n'
						}
						else{
							propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
							propcode += indent + '	if(_'+prop.name+'.length === 4)$a[$o+'+(o)+']=(_'+prop.name+'[0]+2048<<12) + (_'+prop.name+'[1]+2048|0),$a[$o+'+(o+1)+']=(_'+prop.name+'[2]+2048<<12) + (_'+prop.name+'[3]+2048|0)\n'
							propcode += indent + '	else if(_'+prop.name+'.length === 1)$a[$o+'+o+']=$a[$o+'+(o+1)+']=((_'+prop.name+'[0]+2048)<<12) + ((_'+prop.name+'[0]+2048)|0)\n'
							propcode += indent + '}\n'
							propcode += indent + 'else if(typeof _'+prop.name+' === "number")$a[$o+'+o+']=$a[$o+'+(o+1)+']=((_'+prop.name+'+2048)<<12) + ((_'+prop.name+'+2048)|0)\n'
						}
					}
				}
				else{
					propcode += indent + 'var _' + prop.name + ' = '+ propsource +'\n'
					if(prop.config.noCast){
						propcode += indent +'$a[$o+'+(o)+']=_'+prop.name+'[0],$a[$o+'+(o+1)+']=_'+prop.name+'[1],$a[$o+'+(o+2)+']=_'+prop.name+'[2],$a[$o+'+(o+3)+']=_'+prop.name+'[3]\n'
					}
					else{
						propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
						propcode += indent + '	if(_'+prop.name+'.length === 4)$a[$o+'+(o)+']=_'+prop.name+'[0],$a[$o+'+(o+1)+']=_'+prop.name+'[1],$a[$o+'+(o+2)+']=_'+prop.name+'[2],$a[$o+'+(o+3)+']=_'+prop.name+'[3]\n'
						propcode += indent + '	else if(_'+prop.name+'.length === 1)$a[$o+'+o+']=$a[$o+'+(o+1)+']=$a[$o+'+(o+2)+']=$a[$o+'+(o+3)+']=_'+prop.name+'[0]\n'
						propcode += indent + '	else if(_'+prop.name+'.length === 2)this.$parseColor(_'+prop.name+'[0], _'+prop.name+'[1],$a,$o+'+o+')\n'
						propcode += indent + '}\n'
						propcode += indent + 'else if(typeof _'+prop.name+' === "string")this.$parseColor(_'+prop.name+',1.0,$a,$o+'+o+')\n'
						propcode += indent + 'else if(typeof _'+prop.name+' === "number")$a[$o+'+o+'] = $a[$o+'+(o+1)+'] = $a[$o+'+(o+2)+']=$a[$o+'+(o+3)+']=_'+prop.name+'\n'
					}
				}
			}
			else if(prop.type.name === 'vec2'){
				// check packing
				var pack = prop.config.pack
				if(pack){
					propcode += indent + 'var _' + prop.name + ' = '+ propsource +'\n'
					if(pack === 'float12'){
						if(fastWrite || prop.config.noCast){
							propcode += indent + '$a[$o+'+(o)+']=((_'+prop.name+'[0]*4095)<<12) + ((_'+prop.name+'[1]*4095)|0)\n'
						}
						else{
							propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
							propcode += indent + '	$a[$o+'+(o)+']=((_'+prop.name+'[0]*4095)<<12) + ((_'+prop.name+'[1]*4095)|0)\n'
							propcode += indent + '}\n'
							propcode += indent + 'else $a[$o+'+o+']=((_'+prop.name+'*4095)<<12) + ((_'+prop.name+'*4095)|0)\n'
						}
					}
					else{ // int packing
						if(fastWrite || prop.config.noCast){
							propcode += indent + '$a[$o+'+(o)+']=(_'+prop.name+'[0]+2048<<12) + (_'+prop.name+'[1]+2048|0)\n'
						}
						else{
							propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
							propcode += indent + '	$a[$o+'+(o)+']=(_'+prop.name+'[0]+2048<<12) + (_'+prop.name+'[1]+2048|0)\n'
							propcode += indent + '}\n'
							propcode += indent + 'else if(typeof _'+prop.name+' === "number")$a[$o+'+o+']=((_'+prop.name+')+2048<<12) + ((_'+prop.name+')+2048|0)\n'
						}
					}
				}
				else{
					propcode += indent + 'var _' + prop.name + ' = '+ propsource +'\n'
					if(fastWrite || prop.config.noCast){
						propcode += indent + '$a[$o+'+(o)+']=_'+prop.name+'[0],$a[$o+'+(o+1)+']=_'+prop.name+'[1]\n'
					}
					else{
						propcode += indent + 'if(typeof _'+prop.name+' === "object"){\n'
						propcode += indent + '	$a[$o+'+(o)+']=_'+prop.name+'[0],$a[$o+'+(o+1)+']=_'+prop.name+'[1]\n'
						propcode += indent + '}\n'
						propcode += indent + 'else $a[$o+'+(o)+']=$a[$o+'+(o+1)+']=_'+prop.name+'\n'
					}
				}
			}
			else{
				if(slots === 1){
					propcode += indent + '$a[$o+'+o+'] = '+propsource+'\n'
				}
				else{
					propcode += indent + 'var _' + prop.name + ' = '+propsource+'\n'
					//propcode += indent + 'if(_'+prop.name+' === undefined) console.error("Property '+prop.name+' is undefined")\n'
					//propcode += indent + 'else '
					for(let i = 0; i < slots; i++){
						if(i) propcode += ','
						propcode += '$a[$o+'+(o+i)+']=_'+prop.name+'['+i+']\n'
					}
					propcode += '\n'
				}
			}

			if(noInPlace){
				propcode += indent+'}\n'
			}			
		}

		// if we dont have per instance tweening
		if(!instanceProps.this_DOT_tween){
			code += indent + 'if($proto.tween > 0){\n'

			if(instanceProps.this_DOT_duration){
				code += indent + '	var $duration = $a[$o + ' + instanceProps.this_DOT_duration.offset +']\n'
			}
			else{
				code += indent + '	var $duration = $proto.duration\n'
			}			
			code += indent + '	var $tweenStart = $a[$o + ' + instanceProps.this_DOT_tweenStart.offset +']\n'
			code += indent + '	if(!$proto.noInterrupt && $view._time < $tweenStart +  $duration){\n'
			code += indent + '	var $ease = $proto.ease\n'
			code += indent + '	var $time = $proto.tweenTime($proto.tween'
			code += ',Math.min(1,Math.max(0,($view._time - $a[$o + ' + instanceProps.this_DOT_tweenStart.offset +'])/ $duration))'
			code += ',$ease[0],$ease[1],$ease[2],$ease[3]'
			code += ')\n'
		}
		else{ // we do have per instance tweening
			code += indent + 'var $tween = $a[$o + ' + instanceProps.this_DOT_tween.offset +']\n'
			code += indent + 'if($tween > 0 || $turtle._tween > 0){\n'
			code += indent + '	var $duration = $a[$o + ' + instanceProps.this_DOT_duration.offset +']\n'
			code += indent + '	var $tweenStart = $a[$o + ' + instanceProps.this_DOT_tweenStart.offset +']\n'
			code += indent + '	var $timeMax = $view._time + $turtle._duration\n'
			code += indent +'	if($tweenStart !==0 && $timeMax > $view.todo.timeMax) $view.todo.timeMax = $timeMax\n'
			code += indent + '	if($view._time < $tweenStart + $duration){\n'
			code += indent + '		var $time = $proto.tweenTime($tween'
			code += ',Math.min(1,Math.max(0,($view._time - $tweenStart)/$duration))'
			code += ',$a[$o + ' + instanceProps.this_DOT_ease.offset +']'
			code += ',$a[$o + ' + (instanceProps.this_DOT_ease.offset+1) +']'
			code += ',$a[$o + ' + (instanceProps.this_DOT_ease.offset+2) +']'
			code += ',$a[$o + ' + (instanceProps.this_DOT_ease.offset+3) +']'
			code += ')\n'
		}
		code += indent + tweencode 
		code += indent + '	}\n'
		code += indent + '}\n'

		if(hasTweenDelta){
			code += 'if($tweenDelta>0){\n'
			code += deltafwd
			code += '}\n'
			code += 'else{\n'
			code += copyfwd
			code += '}\n'
		}
		else{
			code += copyprev
		}

		code += propcode

		if(!instanceProps.this_DOT_tween){
			code += indent + 'var $timeMax = $view._time + '
			code += (instanceProps.this_DOT_duration?'$a[$o + ' + instanceProps.this_DOT_duration.offset +']':'$proto.duration')+'\n'
			code += indent + 'if($tweenStart !==0 && $timeMax > $view.todo.timeMax) $view.todo.timeMax = $timeMax\n'
		}

		return code
	}

}

function stylePropCode(indent, inobj, styleProps, styleLevel, noif){
	var code = ''
	for(let key in styleProps){
		var prop = styleProps[key]
		var name = prop.name
		if(prop.config.noStyle) continue
		if(styleLevel && prop.config.styleLevel > styleLevel) continue
		if(!noif){
			code += indent+'if(_'+name+' === undefined) _'+name+ ' = '+inobj+'.' + name +'\n'
		}
		else{
			code += indent+'_'+name+ ' = '+inobj+'.' + name +'\n'
		}
	}
	return code
}

function styleStampRootCode(indent, inobj, props, styleProps, styleLevel){
	var code = ''
	for(let key in styleProps){
		var prop = styleProps[key]
		var name = prop.name
		if(prop.config.noStyle) continue
		if(styleLevel && prop.config.styleLevel > styleLevel) continue
		if(name in props){
			code += indent+'_'+name+ ' = '+inobj+'._' + name +'\n'
		}
	}
	return code
}