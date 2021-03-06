import { nest } from 'nesthydrationjs'
const debug = require('debug')('join-monster')

import { queryASTToSqlAST, getGraphQLType } from './queryASTToSqlAST'
import stringifySqlAST from './stringifySqlAST'
import defineObjectShape from './defineObjectShape'
import { emphasize, inspect } from './util'
import util from 'util'


/**
 * User-defined function that sends a raw SQL query to the databse.
 * @callback dbCall
 * @param {String} sql - The SQL generated by `joinMonster` for the batch fetching. Use it to get the data from your database.
 * @param {Function} [done] - An error-first "done" callback. Only define this parameter if you don't want to return a `Promise`.
 * @returns {Array|Promise<Array>} The raw data as a flat array of objects. Each object must represent a row from the result set.
 */
/**
 * Function for generating a `WHERE` condition.
 * @callback where
 * @param {String} tableAlias - The alias generated for this table. Already double-quoted.
 * @param {Object} args - The GraphQL arguments for this field.
 * @param {Object} context - An Object with arbitrary contextual information.
 * @returns {String} The condition for the `WHERE` clause.
 */
/**
 * Function for generating a `JOIN` condition.
 * @callback sqlJoin
 * @param {String} parentTable - The alias generated for the parent's table. Already double-quoted.
 * @param {String} childTable - The alias for the child's table. Already double-quoted.
 * @returns {String} The condition for the `LEFT JOIN`.
 */

/**
 * Takes the GraphQL AST and returns a nest Object with the data.
 * @param {Object} astInfo - Contains the parsed GraphQL query, schema definition, and more. Obtained from the fourth argument to the resolver.
 * @param {Object} context - An arbitrary object that gets passed to the `where` function. Useful for contextual infomation that influeces the  `WHERE` condition, e.g. session, logged in user, localization.
 * @param {dbCall} dbCall - A function that is passed the compiled SQL that calls the database and returns (a promise of) the data.
 * @returns {Promise<Object>} The correctly nested data from the database.
 */
function joinMonster(ast, context, dbCall) {
  // we need to read the query AST and build a new "SQL AST" from which the SQL and
  const sqlAST = queryASTToSqlAST(ast)
  const { sql, shapeDefinition } = compileSqlAST(sqlAST, context)
  if (!sql) return Promise.resolve({})

  // call their function for querying the DB, handle the different cases, do some validation, return a promise of the object
  return handleUserDbCall(dbCall, sql, shapeDefinition)
}

function compileSqlAST(sqlAST, context) {
  debug(emphasize('SQL_AST'), inspect(sqlAST))

  // now convert the "SQL AST" to sql
  const sql = stringifySqlAST(sqlAST, context)
  debug(emphasize('SQL'), inspect(sql))

  // figure out the shape of the object and define it for the NestHydration library so it can build the object nesting
  const shapeDefinition = defineObjectShape(sqlAST)
  debug(emphasize('SHAPE_DEFINITION'), inspect(shapeDefinition))
  return { sql, shapeDefinition }
}

/**
 * A helper for resolving the Node type in Relay.
 * @param {String} typeName - The Name of the GraphQLObjectType
 * @param {Object} astInfo - Contains the parsed GraphQL query, schema definition, and more. Obtained from the fourth argument to the resolver.
 * @param {Object} context - An arbitrary object that gets passed to the where function. Useful for contextual infomation that influeces the  WHERE condition, e.g. session, logged in user, localization.
 * @param {where} where - A function that returns the WHERE condition.
 * @param {Function} dbCall - A function that is passed the compiled SQL that calls the database and returns (a promise of) the data.
 * @returns {Promise<Object>} The correctly nested data from the database. The GraphQL Type is added to the "\_\_type\_\_" property, which is helpful for the `resolveType` function in the `nodeDefinitions` of **graphql-relay-js**.
 */
function getNode(typeName, ast, context, where, dbCall) {
  // get the GraphQL type from the schema using the name
  const type = ast.schema.getType(typeName)
  // our getGraphQLType expects every requested field to be in the schema definition. "node" isn't a parent of whatever type we're getting, so we'll just wrap that type in an object that LOOKS that same as a hypothetical Node type
  const fakeParentNode = {
    _fields: {
      node: {
        type,
        name: type.name.toLowerCase(),
        where
      }
    }
  }
  const sqlAST = {}
  // uses the same underlying function as the main `joinMonster`
  getGraphQLType(ast.fieldASTs[0], fakeParentNode, sqlAST, ast.fragments, new Set)
  const { sql, shapeDefinition } = compileSqlAST(sqlAST, context)
  return handleUserDbCall(dbCall, sql, shapeDefinition).then(obj => {
    // after we get the data, slap the Type on there to assist with determining the type
    obj.__type__ = type
    return obj
  })
}

joinMonster.getNode = getNode

// handles the different callback signatures and return values.
function handleUserDbCall(dbCall, sql, shapeDefinition) {
  // if there are two args, we're in "callback mode"
  if (dbCall.length === 2) {
    // wrap it in a promise
    return new Promise((resolve, reject) => {
      // wait for them to call "done"
      dbCall(sql, (err, rows) => {
        if (err) {
          reject(err)
        } else {
          rows = validate(rows)
          debug(emphasize('RAW_DATA'), inspect(rows.slice(0, 10)))
          debug(`${rows.length} rows...`)
          resolve(nest(rows, shapeDefinition))
        }
      })
    })
  }

  const result = dbCall(sql)
  // if their func gave us a promise for the data, wait for the data
  if (typeof result.then === 'function') {
    return result.then(rows => {
      rows = validate(rows)
      debug(emphasize('RAW DATA'), inspect(rows.slice(0, 10)))
      debug(`${rows.length} rows...`)
      return nest(rows, shapeDefinition)
    })
  // otherwise, they were supposed to give us the data directly
  } else {
    return Promise.resolve(nest(validate(result), shapeDefinition))
  }
}

// validate the data they gave us
function validate(rows) {
  // its supposed to be an array of objects
  if (Array.isArray(rows)) return rows
  // a check for the most common error. a lot of ORMs return an object with the desired data on the `rows` property
  else if (rows && rows.rows) return rows.rows
  else {
    throw new Error(`"dbCall" function must return/resolve an array of objects where each object is a row from the result set. Instead got ${util.inspect(rows, { depth: 3 })}`)
  }
}

// expose the package version for debugging
joinMonster.version = require('../package.json').version
export default joinMonster

